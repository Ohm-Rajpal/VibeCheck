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
    const poop = "poop";
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
