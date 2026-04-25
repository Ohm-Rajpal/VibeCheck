import * as vscode from 'vscode';

// An AI-authored region within a single file. Stays in the tracker until the
// engineer passes a comprehension checkpoint that covers it (or explicitly
// dismisses it via override).
export interface AIRegion {
  id: string;            // unique within a session, used by panel ↔ tracker
  burstId: string;       // groups regions from the same AI generation event
  file: string;          // absolute path
  startLine: number;     // 0-indexed, inclusive
  endLine: number;       // 0-indexed, inclusive
  text: string;          // the inserted text (for question generation)
  generatedAt: number;   // ms epoch
  status: 'unverified' | 'passed' | 'overridden';
}

type Listener = (file: string) => void;

class RegionTracker {
  private byFile = new Map<string, AIRegion[]>();
  private listeners: Listener[] = [];

  add(region: AIRegion): void {
    const list = this.byFile.get(region.file) ?? [];
    list.push(region);
    this.byFile.set(region.file, list);
    this.emit(region.file);
  }

  addBurst(regions: AIRegion[]): void {
    const filesTouched = new Set<string>();
    for (const r of regions) {
      const list = this.byFile.get(r.file) ?? [];
      list.push(r);
      this.byFile.set(r.file, list);
      filesTouched.add(r.file);
    }
    for (const f of filesTouched) this.emit(f);
  }

  getForFile(file: string): AIRegion[] {
    return this.byFile.get(file) ?? [];
  }

  getUnverified(): AIRegion[] {
    const out: AIRegion[] = [];
    for (const list of this.byFile.values()) {
      for (const r of list) if (r.status === 'unverified') out.push(r);
    }
    return out;
  }

  getByBurst(burstId: string): AIRegion[] {
    const out: AIRegion[] = [];
    for (const list of this.byFile.values()) {
      for (const r of list) if (r.burstId === burstId) out.push(r);
    }
    return out;
  }

  markStatus(ids: string[], status: AIRegion['status']): void {
    const filesTouched = new Set<string>();
    for (const list of this.byFile.values()) {
      for (const r of list) {
        if (ids.includes(r.id)) {
          r.status = status;
          filesTouched.add(r.file);
        }
      }
    }
    for (const f of filesTouched) this.emit(f);
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
  applyEdit(
    file: string,
    editStart: number,
    editEnd: number,
    insertedLines: number
  ): void {
    const list = this.byFile.get(file);
    if (!list) return;
    const lineDelta = insertedLines - (editEnd - editStart);
    if (lineDelta === 0) return; // single-line edit, no line-count change

    const survivors: AIRegion[] = [];
    let touched = false;
    for (const r of list) {
      // Map a region endpoint from old line numbers to new ones.
      //   < editStart            → unchanged
      //   in [editStart, editEnd) → deleted (returns -1)
      //   ≥ editEnd              → shift by lineDelta
      const mapPoint = (n: number): number => {
        if (n < editStart) return n;
        if (n < editEnd) return -1;
        return n + lineDelta;
      };

      let newA = mapPoint(r.startLine);
      let newB = mapPoint(r.endLine);

      if (newA === -1 && newB === -1) {
        // Entire region sat inside the deleted range → drop.
        touched = true;
        continue;
      }
      if (newA === -1) newA = editStart;        // start was deleted; clip
      if (newB === -1) newB = editStart - 1;    // end was deleted; clip

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

  // After a non-AI edit, reconcile each region against the actual document
  // text:
  //   1. clamp endLine to the document's last line (regions can drift beyond
  //      end-of-file when deletions are applied via `applyEdit`)
  //   2. trim leading & trailing blank lines from the region's bounds (so a
  //      region whose tail was deleted but left blank lines doesn't keep
  //      highlighting + labelling those blanks)
  //   3. drop the region entirely if every line within is now whitespace
  //
  // This is called from velocityDetector after each `applyEdit` so the
  // highlights track the real surviving AI content, not a stale envelope.
  gcStaleRegions(doc: vscode.TextDocument): void {
    const file = doc.fileName;
    const list = this.byFile.get(file);
    if (!list || list.length === 0) return;
    const lineCount = doc.lineCount;
    const survivors: AIRegion[] = [];
    let dropped = 0;
    let trimmed = 0;
    for (const r of list) {
      if (r.startLine < 0 || r.startLine >= lineCount) {
        dropped++; // out of bounds → drop
        continue;
      }
      const oldStart = r.startLine;
      const oldEnd = r.endLine;
      let newStart = r.startLine;
      let newEnd = Math.min(r.endLine, lineCount - 1);
      // Trim leading blanks.
      while (newStart <= newEnd && doc.lineAt(newStart).text.trim() === '') {
        newStart++;
      }
      // Trim trailing blanks.
      while (newEnd >= newStart && doc.lineAt(newEnd).text.trim() === '') {
        newEnd--;
      }
      if (newStart > newEnd) {
        dropped++; // entire region collapsed to whitespace → drop
        continue;
      }
      if (newStart !== oldStart || newEnd !== oldEnd) {
        r.startLine = newStart;
        r.endLine = newEnd;
        trimmed++;
      }
      survivors.push(r);
    }
    if (dropped > 0 || trimmed > 0) {
      this.byFile.set(file, survivors);
      this.emit(file);
      const short = file.split('/').pop() ?? file;
      this.logFn(
        `gc ${short}: dropped=${dropped} trimmed=${trimmed} remaining=${survivors.length}`
      );
    }
  }

  // Optional logger plugged in from the extension activation. Keeps regionTracker
  // free of a hard dependency on vscode's OutputChannel API.
  private logFn: (line: string) => void = () => {};
  setLogger(fn: (line: string) => void): void {
    this.logFn = fn;
  }

  onChange(listener: Listener): vscode.Disposable {
    this.listeners.push(listener);
    return new vscode.Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    });
  }

  private emit(file: string) {
    for (const l of this.listeners) l(file);
  }

  stats() {
    let total = 0,
      unverified = 0;
    for (const list of this.byFile.values()) {
      total += list.length;
      for (const r of list) if (r.status === 'unverified') unverified++;
    }
    return { total, unverified, files: this.byFile.size };
  }
}

export const regionTracker = new RegionTracker();
