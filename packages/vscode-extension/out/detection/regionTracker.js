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
exports.regionTracker = void 0;
const vscode = __importStar(require("vscode"));
class RegionTracker {
    constructor() {
        this.byFile = new Map();
        this.listeners = [];
    }
    add(region) {
        const list = this.byFile.get(region.file) ?? [];
        list.push(region);
        this.byFile.set(region.file, list);
        this.emit(region.file);
    }
    addBurst(regions) {
        const filesTouched = new Set();
        for (const r of regions) {
            const list = this.byFile.get(r.file) ?? [];
            list.push(r);
            this.byFile.set(r.file, list);
            filesTouched.add(r.file);
        }
        for (const f of filesTouched)
            this.emit(f);
    }
    getForFile(file) {
        return this.byFile.get(file) ?? [];
    }
    getUnverified() {
        const out = [];
        for (const list of this.byFile.values()) {
            for (const r of list)
                if (r.status === 'unverified')
                    out.push(r);
        }
        return out;
    }
    getByBurst(burstId) {
        const out = [];
        for (const list of this.byFile.values()) {
            for (const r of list)
                if (r.burstId === burstId)
                    out.push(r);
        }
        return out;
    }
    markStatus(ids, status) {
        const filesTouched = new Set();
        for (const list of this.byFile.values()) {
            for (const r of list) {
                if (ids.includes(r.id)) {
                    r.status = status;
                    filesTouched.add(r.file);
                }
            }
        }
        for (const f of filesTouched)
            this.emit(f);
    }
    // Reconcile region bounds against a non-AI edit. Handles all overlap cases:
    //   - edit fully before region → shift region by lineDelta
    //   - edit fully after region  → no change
    //   - edit fully inside region → grow/shrink endLine by lineDelta
    //   - edit overlaps region start → trim start to the edit boundary
    //   - edit overlaps region end   → trim end to the edit boundary
    //   - edit fully contains region → REMOVE region (the AI code was deleted)
    //
    // editStart / editEnd are the [start.line, end.line) of the contentChange
    // (end exclusive in line terms). insertedLines is the number of newlines
    // in the new text (0 for a pure deletion).
    applyEdit(file, editStart, editEnd, insertedLines) {
        const list = this.byFile.get(file);
        if (!list)
            return;
        const lineDelta = insertedLines - (editEnd - editStart);
        if (lineDelta === 0)
            return; // single-line edit, no line-count change
        const survivors = [];
        let touched = false;
        for (const r of list) {
            // Map a region endpoint from old line numbers to new ones.
            //   < editStart            → unchanged
            //   in [editStart, editEnd) → deleted (returns -1)
            //   ≥ editEnd              → shift by lineDelta
            const mapPoint = (n) => {
                if (n < editStart)
                    return n;
                if (n < editEnd)
                    return -1;
                return n + lineDelta;
            };
            let newA = mapPoint(r.startLine);
            let newB = mapPoint(r.endLine);
            if (newA === -1 && newB === -1) {
                // Entire region sat inside the deleted range → drop.
                touched = true;
                continue;
            }
            if (newA === -1)
                newA = editStart; // start was deleted; clip
            if (newB === -1)
                newB = editStart - 1; // end was deleted; clip
            if (newB < newA) {
                // Region collapsed to nothing.
                touched = true;
                continue;
            }
            if (newA !== r.startLine || newB !== r.endLine) {
                r.startLine = newA;
                r.endLine = newB;
                touched = true;
            }
            survivors.push(r);
        }
        if (touched) {
            this.byFile.set(file, survivors);
            this.emit(file);
        }
    }
    onChange(listener) {
        this.listeners.push(listener);
        return new vscode.Disposable(() => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        });
    }
    emit(file) {
        for (const l of this.listeners)
            l(file);
    }
    stats() {
        let total = 0, unverified = 0;
        for (const list of this.byFile.values()) {
            total += list.length;
            for (const r of list)
                if (r.status === 'unverified')
                    unverified++;
        }
        return { total, unverified, files: this.byFile.size };
    }
}
exports.regionTracker = new RegionTracker();
//# sourceMappingURL=regionTracker.js.map