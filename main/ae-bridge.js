const crypto = require('node:crypto');

function escapeExtendScriptString(value) {
  return JSON.stringify(String(value)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function createBridgeScript({ scriptPath, resultPath, taskId }) {
  const safeTaskId = escapeExtendScriptString(taskId);
  const safeScriptPath = escapeExtendScriptString(scriptPath);
  const safeResultPath = escapeExtendScriptString(resultPath);
  return String.raw`/* AE Script Collector bridge - ExtendScript ES3; generated per task. */
(function () {
    var output = { taskId: ${safeTaskId}, ok: false, returnValue: "", error: null };
    function clip(value, max) {
        var text = value === undefined || value === null ? "" : String(value);
        return text.length > max ? text.substring(0, max) : text;
    }
    function jsonEscape(value) {
        return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
    }
    function jsonString(value) {
        return value === null ? "null" : "\"" + jsonEscape(value) + "\"";
    }
    function writeResult() {
        var file = new File(${safeResultPath});
        try {
            file.encoding = "UTF-8";
            file.open("w");
            var errorJson = output.error ? "{\"name\":" + jsonString(output.error.name) + ",\"message\":" + jsonString(output.error.message) + ",\"line\":" + String(output.error.line || 0) + "}" : "null";
            file.write("{\"taskId\":" + jsonString(output.taskId) + ",\"ok\":" + (output.ok ? "true" : "false") + ",\"returnValue\":" + jsonString(output.returnValue) + ",\"error\":" + errorJson + "}");
            file.close();
        } catch (writeError) {
            try { if (file) file.close(); } catch (ignore) {}
        }
    }
    try {
        var result = $.evalFile(new File(${safeScriptPath}));
        output.ok = true;
        output.returnValue = clip(result, 16000);
    } catch (error) {
        output.error = { name: clip(error && error.name, 200), message: clip(error && error.toString ? error.toString() : error, 8000), line: error && error.line ? error.line : 0 };
    }
    writeResult();
}());
`;
}

function createTaskId() { return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`; }

function createMacDoScriptCommand({ applicationName, bridgePath }) {
  return `tell application "${escapeAppleScriptString(applicationName)}" to DoScript "$.evalFile(new File(\\"${escapeAppleScriptString(bridgePath)}\\"));"`;
}

module.exports = { createBridgeScript, createTaskId, escapeExtendScriptString, escapeAppleScriptString, createMacDoScriptCommand };
