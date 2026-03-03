const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { spawn } = require('child_process');
const archiver = require('archiver');

const PORT = process.env.PORT || 3000;
const DRAW_IO_URL = process.env.DRAW_IO_URL || 'http://127.0.0.1:8080/?embed=1&ui=atlas&spin=1&proto=json';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* ------------ IMPORTANT: trust proxy when running behind a proxy ----------- */
app.set('trust proxy', 1); // adjust if you have more than one proxy hop

app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));

// --- utils & storage dirs ---
const DATA_DIR = path.join(__dirname, 'data');
const PAD_DIR = path.join(DATA_DIR, 'pads');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');
const FILES_DIR = path.join(DATA_DIR, 'files');   // per-pad files

for (const d of [DATA_DIR, PAD_DIR, UPLOAD_DIR, OUTPUT_DIR, FILES_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

function sanitizeRoom(input) {
  if (!input) return '';
  return String(input).toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 64);
}
function sanitizeFilename(input) {
  // keep basename, strip traversal, restrict chars
  const base = path.basename(String(input || ''));
  return base.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 128);
}
function padFile(room) { return path.join(PAD_DIR, `${room}.json`); }
function padFilesDir(room) {
  const dir = path.join(FILES_DIR, room);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// list files helper (used for SSR and socket/JSON updates)
function listPadFiles(room) {
  const dir = padFilesDir(room);
  return fs.readdirSync(dir)
    .filter(f => fs.statSync(path.join(dir, f)).isFile())
    .sort((a,b)=>a.localeCompare(b, undefined, { numeric:true }));
}

// --- pads state ---
const pads = Object.create(null);
const saveTimers = Object.create(null);
function loadPad(room) {
  if (pads[room]) return pads[room];
  const f = padFile(room);
  if (fs.existsSync(f)) {
    try {
      const { text = '', version = 0 } = JSON.parse(fs.readFileSync(f, 'utf8'));
      pads[room] = { text, version };
    } catch (err) {
      console.warn(`[${room}] pad data invalid or unreadable; resetting`, err);
      pads[room] = { text: '', version: 0 };
    }
  } else {
    pads[room] = { text: '', version: 0 };
  }
  return pads[room];
}
function scheduleSave(room) {
  clearTimeout(saveTimers[room]);
  saveTimers[room] = setTimeout(() => {
    const state = pads[room] || { text: '', version: 0 };
    fs.writeFile(padFile(room), JSON.stringify(state, null, 2), (err) => {
      if (err) console.error(`[${room}] persist error:`, err);
    });
  }, 250);
}

// --- multer (uploads) ---
const uploadPDF = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (/\.pdf$/i.test(file.originalname) ? cb(null, true) : cb(new Error('Only PDF files are allowed')))
});
const uploadAny = multer({
  dest: (req, file, cb) => cb(null, padFilesDir(sanitizeRoom(req.params.room))),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
});

// --- converter (pdftoppm) ---
function pdfToJpg({ pdfPath, outPrefix, width, quality, dpi }) {
  return new Promise((resolve, reject) => {
    const args = ['-jpeg'];
    if (Number.isInteger(width) && width > 0) args.push('-scale-to', String(width));
    else if (Number.isInteger(dpi) && dpi > 0) args.push('-r', String(dpi));
    if (Number.isInteger(quality) && quality >= 1 && quality <= 100) args.push('-jpegopt', `quality=${quality}`);
    args.push(pdfPath, outPrefix);
    const proc = spawn('pdftoppm', args);
    let stderr = '';
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('error', err => reject(err));
    proc.on('close', code => code !== 0 ? reject(new Error(`pdftoppm exited ${code}: ${stderr}`)) : resolve());
  });
}
function safeCleanup(paths) { for (const p of paths) fs.unlink(p, () => {}); }

// ----------------------------- routes ------------------------------

// login
// Home (tools hub)
app.get('/', (_req, res) => {
  res.render('index', { title: 'Tools' });
});

// Pads: index (enter key / generate) and handle ?room=XYZ
app.get('/pad', (req, res) => {
  const room = sanitizeRoom(req.query.room);
  if (room) return res.redirect(`/pad/${room}`);
  res.render('pad-index', { title: 'Shared Pad' });
});

// Specific pad
app.get('/pad/:room', (req, res) => {
  const room = sanitizeRoom(req.params.room);
  if (!room) return res.redirect('/pad');
  loadPad(room);
  const files = listPadFiles(room);
  res.render('pad', { title: `Pad: ${room}`, room, files });
});

// NEW: JSON list of files for a pad (for reliable live refresh)
app.get('/pad/:room/files.json', (req, res) => {
  const room = sanitizeRoom(req.params.room);
  if (!room) return res.status(400).json({ files: [] });
  try {
    return res.json({ files: listPadFiles(room) });
  } catch {
    return res.json({ files: [] });
  }
});

// Upload file to pad
app.post('/pad/:room/files', uploadAny.single('file'), (req, res) => {
  try {
    const room = sanitizeRoom(req.params.room);
    if (!room) return res.redirect('/pad');

    const original = sanitizeFilename(req.file.originalname || 'file');
    const ext = path.extname(original) || '';
    const base = path.basename(original, ext) || 'file';
    let name = `${base}${ext}`;
    let i = 1;
    while (fs.existsSync(path.join(padFilesDir(room), name))) {
      name = `${base}_${i}${ext}`; i++;
    }
    fs.renameSync(req.file.path, path.join(padFilesDir(room), name));

    // broadcast "files changed" (clients will fetch fresh list)
    io.to(room).emit('files-changed', { room });

    return res.redirect(`/pad/${room}`);
  } catch (e) {
    console.error(e);
    return res.status(400).send('Upload failed');
  }
});

// Download a file from pad
app.get('/pad/:room/files/:file', (req, res) => {
  const room = sanitizeRoom(req.params.room);
  const file = sanitizeFilename(req.params.file);
  const full = path.join(padFilesDir(room), file);
  if (!fs.existsSync(full)) return res.status(404).send('Not found');
  res.download(full);
});

// Delete a file from pad
app.post('/pad/:room/files/:file/delete', (req, res) => {
  const room = sanitizeRoom(req.params.room);
  const file = sanitizeFilename(req.params.file);
  const full = path.join(padFilesDir(room), file);
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);

    // broadcast "files changed" (clients will fetch fresh list)
    io.to(room).emit('files-changed', { room });

    return res.redirect(`/pad/${room}`);
  } catch (e) {
    console.error(e);
    return res.status(400).send('Delete failed');
  }
});

// Tools: Diagram workspace
app.get('/tools/draw', (_req, res) => {
  res.render('draw', { title: 'Diagram Workspace', drawIoUrl: DRAW_IO_URL });
});
// Tools: PDF -> JPG
app.get('/tools/pdf-to-jpg', (_req, res) => {
  res.render('tool_pdf_to_jpg', { title: 'PDF → JPG' });
});
app.post('/tools/pdf-to-jpg', uploadPDF.single('pdf'), async (req, res) => {
  try {
    const quality = Math.min(100, Math.max(1, parseInt(req.body.quality || '85', 10)));
    const width = req.body.width && req.body.width !== 'auto' ? Math.min(4096, Math.max(300, parseInt(req.body.width, 10))) : null;
    const dpi = req.body.dpi ? Math.min(600, Math.max(72, parseInt(req.body.dpi, 10))) : null;

    const pdfPath = req.file.path;
    const base = path.basename(req.file.filename);
    const workPrefix = path.join(OUTPUT_DIR, `pdf_${base}`);

    await pdfToJpg({ pdfPath, outPrefix: workPrefix, width, quality, dpi });

    const dir = path.dirname(workPrefix);
    const stem = path.basename(workPrefix);
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith(stem + '-') && f.endsWith('.jpg'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (files.length === 0) throw new Error('No pages produced');

    if (files.length === 1) {
      const imgPath = path.join(dir, files[0]);
      res.download(imgPath, files[0], () => safeCleanup([pdfPath, imgPath]));
    } else {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="pages.zip"');
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', err => { throw err; });
      archive.pipe(res);
      for (const f of files) archive.file(path.join(dir, f), { name: f });
      archive.finalize();
      res.on('finish', () => safeCleanup([pdfPath, ...files.map(f => path.join(dir, f))]));
    }
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(500).send('Converter not available: pdftoppm not found.');
    console.error(e);
    res.status(400).send('Conversion failed: ' + e.message);
  }
});

// health
app.get('/health', (_req, res) => res.json({ ok: true, pads: Object.keys(pads).length }));

/* --------------------------- sockets (pads) ------------------------ */
io.on('connection', (socket) => {
  let currentRoom = null;
  socket.on('join', ({ room }) => {
    const r = sanitizeRoom(room);
    if (!r) return;
    if (currentRoom) socket.leave(currentRoom);
    currentRoom = r;
    socket.join(r);
    const state = loadPad(r);
    socket.emit('init', { text: state.text, version: state.version, room: r });
    const count = io.sockets.adapter.rooms.get(r)?.size || 0;
    io.to(r).emit('user-count', count);
  });

  // IMPORTANT: don't echo the update back to the sender (prevents clobbering)
  socket.on('text-update', ({ room, text }) => {
    const r = sanitizeRoom(room);
    if (!r || typeof text !== 'string') return;
    const state = loadPad(r);
    state.text = text;
    state.version++;
    scheduleSave(r);
    socket.to(r).emit('text-apply', { text: state.text, version: state.version, room: r });
    socket.emit('ack', { version: state.version }); // let sender know we're synced
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
    io.to(currentRoom).emit('user-count', count);
  });
});

server.listen(PORT, () => {
  console.log(`Tools + Shared Pad running on http://localhost:${PORT}`);
});
