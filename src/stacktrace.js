const path = require('path');

// Matches a V8 stack frame line, with or without a function name:
//   "at functionName (file:line:col)"
//   "at new ClassName (file:line:col)"
//   "at file:line:col"
const FRAME_RE = /at\s+(?:(.+?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/;

function parseFrames(stack) {
  if (!stack || typeof stack !== 'string') return [];
  return stack
    .split('\n')
    .slice(1) // first line is "ErrorName: message", not a frame
    .map((line) => {
      const match = FRAME_RE.exec(line.trim());
      if (!match) return null;
      const [, fn, file, lineNo, col] = match;
      return {
        function: fn ? fn.trim() : '<anonymous>',
        file: file.trim(),
        line: Number(lineNo),
        column: Number(col),
      };
    })
    .filter(Boolean);
}

// A frame is "vendor" (not the user's own app code) if it's inside
// node_modules, a Node internal module, or the SDK's own source — none of
// those are where the app's bug actually lives.
function isVendorFrame(frame, sdkDir) {
  const file = frame.file || '';
  if (!file) return true;
  if (file.startsWith('node:') || file.startsWith('internal/')) return true;
  if (file.includes('node_modules')) return true;
  if (sdkDir && (file === sdkDir || file.startsWith(sdkDir + path.sep) || file.startsWith(sdkDir + '/'))) return true;
  return false;
}

// Finds the first stack frame that belongs to the app's own code, skipping
// node_modules/Node-internal/SDK-internal frames — this is "where in the
// user's code the error actually happened," as opposed to the full trace
// which is mostly framework/middleware noise the user has to scan past.
function locateErrorSource(stack, sdkDir) {
  const frames = parseFrames(stack);
  return frames.find((frame) => !isVendorFrame(frame, sdkDir)) || null;
}

module.exports = { parseFrames, locateErrorSource };
