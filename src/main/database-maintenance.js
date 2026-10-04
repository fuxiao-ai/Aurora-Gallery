'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

function runDatabaseMaintenance(dbPath, operation) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '..', 'workers', 'maintenance-worker.js'), {
      workerData: { dbPath, operation },
    });
    let response;
    let failure;
    worker.on('message', (message) => {
      response = message;
    });
    worker.on('error', (error) => {
      failure = error;
    });
    // Only release the maintenance lock after the connection and thread have exited.
    worker.on('exit', (code) => {
      if (failure) reject(failure);
      else if (code !== 0 || !response) reject(new Error('Maintenance worker exited: ' + code));
      else if (!response.ok) reject(new Error(response.error));
      else resolve(response.result);
    });
  });
}

module.exports = { runDatabaseMaintenance };
