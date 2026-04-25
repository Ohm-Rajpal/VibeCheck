"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const velocityDetector_1 = require("./detection/velocityDetector");
const panel_1 = require("./checkpoint/panel");
const sidebar_1 = require("./growth/sidebar");
const CHECKPOINT_PORT = Number(process.env.CHECKPOINT_PORT ?? 3456);
function activate(context) {
    // 1. Local HTTP server: receives notifications from pre-commit hook + Devin webhook.
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/checkpoint') {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                try {
                    const { session_id, questions, trigger } = JSON.parse(body);
                    (0, panel_1.openCheckpointPanel)(context, session_id, questions, trigger);
                    res.writeHead(200);
                    res.end('ok');
                }
                catch (err) {
                    res.writeHead(400);
                    res.end('bad payload');
                }
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    server.listen(CHECKPOINT_PORT);
    context.subscriptions.push({ dispose: () => server.close() });
    // 2. Layer 1 — velocity detector.
    (0, velocityDetector_1.activateVelocityDetector)(context);
    // 3. Growth dashboard sidebar.
    (0, sidebar_1.activateGrowthSidebar)(context);
    // 4. Commands.
    context.subscriptions.push(vscode.commands.registerCommand('vibecheck.showGrowth', () => {
        vscode.commands.executeCommand('workbench.view.extension.vibecheck');
    }), vscode.commands.registerCommand('vibecheck.openCheckpoint', () => {
        (0, panel_1.openCheckpointPanel)(context, 'manual', [], 'pre_commit');
    }));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map