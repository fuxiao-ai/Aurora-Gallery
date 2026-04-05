#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PhotoDatabase = require('../src/database');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function makePhoto(rootId, folderPath, fileName, fileType, hasThumbnail, dateTaken) {
  return {
    rootId: rootId,
    folderPath: folderPath,
    fileName: fileName,
    filePath: path.join(folderPath, fileName),
    fileSize: 123,
    fileType: fileType,
    width: 1920,
    height: 1080,
    dateTaken: dateTaken,
    dateModified: dateTaken,
    thumbnail: hasThumbnail ? Buffer.from([1, 2, 3]) : null,
    hasThumbnail: hasThumbnail ? 1 : 0,
  };
}

function run() {
  const dbPath = path.join(os.tmpdir(), `aurora-gallery-smoke-${Date.now()}.db`);
  let db = null;
  try {
    db = new PhotoDatabase(dbPath);
    const root1 = db.addRootFolder('C:\\smoke\\root1');
    const root2 = db.addRootFolder('C:\\smoke\\root2');

    db.insertPhoto(
      makePhoto(root1, 'C:\\smoke\\root1\\folderA', 'a1.jpg', 'jpg', 1, '2026-01-01T10:00:00'),
    );
    db.insertPhoto(
      makePhoto(root1, 'C:\\smoke\\root1\\folderA', 'a2.mp4', 'mp4', 0, '2026-01-01T11:00:00'),
    );
    db.insertPhoto(
      makePhoto(root1, 'C:\\smoke\\root1\\folderB', 'b1.png', 'png', 0, '2026-01-02T10:00:00'),
    );
    db.insertPhoto(
      makePhoto(root2, 'C:\\smoke\\root2\\folderC', 'c1.mov', 'mov', 1, '2026-01-03T10:00:00'),
    );

    const all = db.getFolderCovers({});
    const byRoot1 = db.getFolderCovers({ rootId: root1 });
    const onlyImage = db.getFolderCovers({ mediaType: 'image' });
    const onlyVideo = db.getFolderCovers({ mediaType: 'video' });
    const root1Image = db.getFolderCovers({ rootId: root1, mediaType: 'image' });
    const root1Video = db.getFolderCovers({ rootId: root1, mediaType: 'video' });

    const allCovers = all.covers || [];
    assert(allCovers.length === 3 && all.total === 3, 'all covers should include 3 folders');
    assert((byRoot1.covers || []).length === 2, 'root1 covers should include 2 folders');
    assert((onlyImage.covers || []).length === 2, 'image covers should include 2 folders');
    assert((onlyVideo.covers || []).length === 2, 'video covers should include 2 folders');
    assert((root1Image.covers || []).length === 2, 'root1 image covers should include 2 folders');
    assert((root1Video.covers || []).length === 1, 'root1 video covers should include 1 folder');

    const paged = db.getFolderCovers({ page: 1, pageSize: 2, mediaType: 'image' });
    assert(
      (paged.covers || []).length === 2 && paged.total === 2 && paged.totalPages === 1,
      'paged folder covers',
    );

    console.log('[db-smoke] PASS');
    console.log(
      `[db-smoke] sizes all=${all.length} root1=${byRoot1.length} image=${onlyImage.length} video=${onlyVideo.length}`,
    );
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {}
    }
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch (e) {}
  }
}

run();
