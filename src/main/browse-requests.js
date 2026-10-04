'use strict';

const requests = new Map();

function begin(sender, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) return;
  const previous = requests.get(sender.id);
  if (previous && sequence <= previous.sequence) return;
  if (previous) previous.controller.abort();
  else {
    sender.once('destroyed', () => {
      const current = requests.get(sender.id);
      if (current) current.controller.abort();
      requests.delete(sender.id);
    });
    // A renderer reload restarts its sequence at one.
    sender.on('render-process-gone', () => {
      const current = requests.get(sender.id);
      if (current) {
        current.controller.abort();
        current.sequence = 0;
      }
    });
    sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) {
        const current = requests.get(sender.id);
        if (current) {
          current.controller.abort();
          current.sequence = 0;
        }
      }
    });
  }
  requests.set(sender.id, { sequence, controller: new AbortController() });
}

function control(sender, options) {
  if (!options || options.browseRequestId === undefined) return undefined;
  const current = requests.get(sender.id);
  if (!current || current.sequence !== options.browseRequestId) {
    throw new Error('db-read cancelled');
  }
  return { signal: current.controller.signal };
}

module.exports = { begin, control };
