import ProjectHistory from './project-history.js';

/** Owns history controls/gestures; the app supplies project capture and atomic restoration. */
export default class HistoryController {
    constructor({ capture, apply, canEdit, onError, root = document, shouldGroupDrag = () => false }) {
        this.capture = capture;
        this.apply = apply;
        this.canEdit = canEdit;
        this.onError = onError;
        this.root = root;
        this.history = new ProjectHistory({ maxEntries: 100, mergeWindowMs: 600 });
        this.ready = false;
        this.applying = false;
        this.mergeKey = null;
        this.mergeAt = 0;
        this.libraryKey = '';
        this.undoButton = root.getElementById('btn-undo');
        this.redoButton = root.getElementById('btn-redo');
        this.undoButton?.addEventListener('click', () => this.undo());
        this.redoButton?.addEventListener('click', () => this.redo());
        root.addEventListener('input', event => {
            const input = event.target;
            this.mergeKey = null;
            if (!['number', 'range'].includes(input.type)) return;
            const card = input.closest('.image-item');
            const field = /rotation/.test(input.className) ? 'rotation' : /zoom/.test(input.className) ? 'zoom' : input.className;
            this.mergeKey = `input:${input.id || `${card?.dataset.id || ''}:${field}`}`;
            this.mergeAt = Date.now();
        }, true);
        root.addEventListener('pointerdown', event => {
            this.mergeKey = null;
            if (event.target.id === 'planner-canvas' && shouldGroupDrag() && !this.history.group) {
                this.history.beginGroup('crop');
            }
        }, true);
        const endDrag = () => this.history.endGroup();
        root.defaultView?.addEventListener('pointerup', endDrag);
        root.defaultView?.addEventListener('pointercancel', endDrag);
        root.addEventListener('keydown', event => {
            if (event.target.id === 'planner-canvas' && !(event.ctrlKey || event.metaKey)) this.mergeKey = null;
            if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
            if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
            const key = event.key.toLowerCase();
            if (key === 'z') {
                event.preventDefault();
                if (event.shiftKey) this.redo(); else this.undo();
            } else if (key === 'y' && !event.shiftKey) {
                event.preventDefault();
                this.redo();
            }
        }, true);
        root.addEventListener('projectsessionchange', () => this.refresh());
    }

    refresh() {
        const enabled = this.ready && !this.applying && this.canEdit();
        if (this.undoButton) this.undoButton.disabled = !enabled || !this.history.canUndo;
        if (this.redoButton) this.redoButton.disabled = !enabled || !this.history.canRedo;
    }

    reset(snapshot = this.capture()) {
        this.history.reset(snapshot);
        this.libraryKey = this.imageKey(snapshot);
        this.ready = true;
        this.refresh();
    }

    imageKey(snapshot) {
        return JSON.stringify((snapshot.images || []).map(image => image.id).sort());
    }

    record(snapshot = this.capture()) {
        if (!this.ready || this.applying || !this.canEdit()) return;
        if (this.imageKey(snapshot) !== this.libraryKey) { this.reset(snapshot); return; }
        this.history.record(snapshot, { mergeKey: Date.now() - this.mergeAt <= 600 ? this.mergeKey : null });
        this.refresh();
    }

    async move(direction) {
        if (!this.ready || this.applying || !this.canEdit()) return;
        this.record();
        const target = this.history[direction]();
        if (!target) { this.refresh(); return; }
        this.applying = true;
        this.refresh();
        try {
            await this.apply(target);
        } catch (error) {
            // Keep the cursor at the last successfully applied state.
            this.history[direction === 'undo' ? 'redo' : 'undo']();
            this.onError?.(error);
        } finally {
            this.applying = false;
            this.refresh();
        }
    }

    undo() { return this.move('undo'); }
    redo() { return this.move('redo'); }
}
