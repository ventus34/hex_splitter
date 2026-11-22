import HexMath from './hex-math.js';
import { cellKey } from './grid-topology.js';
import { i18n } from './i18n.js?v=1.0.3';

export default class GridEditor {
    constructor({ grid, planner, canEdit, onChange }) {
        this.grid = grid;
        this.planner = planner;
        this.canEdit = canEdit;
        this.onChange = onChange;
        this.candidates = new Map();
        this.selected = null;
        this.root = document.getElementById('hex-editor');
        this.fields = document.getElementById('hex-editor-fields');
        this.title = document.getElementById('hex-editor-title');
        this.neighbors = document.getElementById('hex-neighbor-actions');
        this.details = document.getElementById('hex-shape-editor');
        this.firstButton = document.getElementById('btn-first-hex');
        this.removeButton = document.getElementById('btn-remove-hex');
        this.shapeMode = document.getElementById('hex-shape-mode');
        this.halfField = document.getElementById('hex-half-side-field');
        this.halfSide = document.getElementById('hex-half-side');
        this.cuts = document.getElementById('hex-cut-depths');
        this.preview = document.getElementById('hex-shape-preview');
        this.status = document.getElementById('hex-shape-status');
        this.applyButton = document.getElementById('btn-apply-hex-shape');

        for (let side = 0; side < 6; side++) {
            this.halfSide.add(new Option(String(side + 1), String(side)));
            const label = document.createElement('label');
            const name = document.createElement('span');
            name.textContent = String(side + 1);
            const input = document.createElement('input');
            Object.assign(input, { type: 'number', min: '0', max: '99', step: '1', value: '0', className: 'form-input' });
            label.append(name, input);
            this.cuts.append(label);
        }
        this.depths = [...this.cuts.querySelectorAll('input')];
        this.firstButton.addEventListener('click', () => {
            if (this.grid.cells.size === 0 && this.add(0, 0)) this.planner.canvas.focus();
        });
        this.removeButton.addEventListener('click', () => this.remove());
        this.applyButton.addEventListener('click', () => this.applyShape());
        this.details.addEventListener('input', () => this.updateDraft());
        this.details.addEventListener('toggle', () => {
            if (this.details.open && this.selected) this.updateDraft();
        });
        document.addEventListener('languagechange', () => this.refresh());
        this.planner.gridEditor = this;
    }

    setSelection(cell, { focusCanvas = false } = {}) {
        this.planner.selectedCellKey = cell ? cellKey(cell.q, cell.r) : null;
        this.planner.hoveredCellKey = this.planner.selectedCellKey;
        if (cell) document.getElementById('planner-live-status').textContent = i18n.t('selected_hex', { code: cell.label });
        this.refresh();
        if (this.planner.fitView) this.planner.centerGrid();
        this.planner.scheduleRender();
        if (focusCanvas) this.planner.canvas.focus({ preventScroll: true });
    }

    refresh() {
        const editingGrid = this.planner.interactionMode === 'grid';
        const previous = this.selected;
        this.selected = editingGrid ? this.planner.getSelectedCell() : null;
        const empty = editingGrid && this.grid.cells.size === 0;
        this.root.classList.toggle('hidden', !this.selected && !empty);
        this.fields.classList.toggle('hidden', !this.selected);
        this.firstButton.classList.toggle('hidden', !empty);
        this.candidates = new Map();
        if (!this.selected) return;

        this.title.textContent = i18n.t('selected_hex', { code: this.selected.label });
        const neighbors = this.grid.getAvailableNeighbors(this.selected);
        this.candidates = new Map(neighbors.map(cell => [cellKey(cell.q, cell.r), cell]));
        this.neighbors.replaceChildren(...neighbors.map(cell => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-secondary btn-sm';
            button.textContent = `+ ${cell.label}`;
            button.setAttribute('aria-label', i18n.t('add_neighbor', { code: cell.label }));
            button.addEventListener('click', () => {
                if (this.add(cell.q, cell.r)) this.planner.canvas.focus({ preventScroll: true });
            });
            return button;
        }));
        this.depths.forEach((input, side) => input.setAttribute('aria-label', i18n.t('cut_depth', { side: side + 1 })));
        if (previous !== this.selected) this.loadShape();
        this.updateDraft();
    }

    keepPosition(change) {
        const before = this.grid.getBoundingBoxMm();
        if (!change()) return false;
        const after = this.grid.getBoundingBoxMm();
        if (before.width && after.width) {
            this.planner.panX += (after.minX + after.width / 2 - before.minX - before.width / 2) * this.planner.zoom;
            this.planner.panY += (after.minY + after.height / 2 - before.minY - before.height / 2) * this.planner.zoom;
        } else if (after.width) {
            this.planner.centerGrid();
        }
        return true;
    }

    add(q, r) {
        if (!this.canEdit() || !this.keepPosition(() => this.grid.addCell(q, r))) return false;
        this.setSelection(this.selected ?? this.grid.getCell(q, r));
        this.onChange({ topology: true });
        return true;
    }

    remove() {
        const cell = this.selected;
        if (!cell || !this.canEdit()) return;
        const grouped = this.grid.panelExport.groups.some(group => group.cells.some(({ q, r }) => q === cell.q && r === cell.r));
        if (!confirm(i18n.t(grouped ? 'confirm_remove_group_hex' : 'confirm_remove_hex', { code: cell.label }))) return;
        if (!this.canEdit() || !this.keepPosition(() => this.grid.removeCell(cell.q, cell.r))) return;
        this.setSelection(null, { focusCanvas: this.grid.cells.size > 0 });
        if (!this.grid.cells.size) this.firstButton.focus();
        this.onChange({ topology: true });
    }

    loadShape() {
        const shape = this.selected.shape;
        const depths = shape?.depths ?? Array(6).fill(0);
        const halfSide = depths.indexOf(50);
        const isHalf = halfSide !== -1 && depths.filter(Boolean).length === 1;
        this.shapeMode.options[3].hidden = shape?.kind !== 'legacy';
        this.shapeMode.value = isHalf ? 'half' : shape?.kind ?? 'full';
        this.halfSide.value = String(isHalf ? halfSide : 0);
        this.depths.forEach((input, side) => { input.value = String(depths[side]); });
    }

    readDraft() {
        if (this.shapeMode.value === 'cuts') {
            if (this.depths.some(input => !input.validity.valid)) return null;
            const depths = this.depths.map(input => Number(input.value));
            return depths.some(Boolean) ? { kind: 'cuts', depths } : { kind: 'full' };
        }
        if (this.shapeMode.value === 'half') {
            return { kind: 'cuts', depths: Array.from({ length: 6 }, (_, side) => side === Number(this.halfSide.value) ? 50 : 0) };
        }
        return { kind: this.shapeMode.value };
    }

    updateDraft() {
        const shape = this.readDraft();
        this.halfField.classList.toggle('hidden', this.shapeMode.value !== 'half');
        this.cuts.classList.toggle('hidden', this.shapeMode.value !== 'cuts');
        const vertices = shape ? HexMath.getCellVertices({ ...this.selected, shape }, this.grid.config) : [];
        const valid = vertices.length >= 3;
        this.applyButton.disabled = !this.canEdit() || !valid || JSON.stringify(this.selected.shape) === JSON.stringify(shape);
        this.status.textContent = valid
            ? i18n.t('shape_dimensions', dimensions(HexMath.getPolygonBounds(vertices)))
            : i18n.t('shape_invalid');
        if (this.details.open) this.drawDraft(vertices);
    }

    applyShape() {
        const shape = this.readDraft();
        if (!this.canEdit() || !this.selected || !shape || this.applyButton.disabled) return;
        if (!this.keepPosition(() => this.grid.setCellShape(this.selected, shape))) return;
        this.loadShape();
        this.updateDraft();
        this.planner.canvas.focus({ preventScroll: true });
        this.onChange({ topology: false });
    }

    drawDraft(vertices) {
        const { width, height } = this.preview;
        const ctx = this.preview.getContext('2d');
        const config = this.grid.config;
        const full = HexMath.getCellVertices({ ...this.selected, shape: { kind: 'full' } }, config);
        const bounds = HexMath.getPolygonBounds(full);
        const scale = Math.min((width - 32) / bounds.width, (height - 32) / bounds.height);
        const points = polygon => polygon.map(({ x, y }) => [
            width / 2 + (x - bounds.minX - bounds.width / 2) * scale,
            height / 2 + (y - bounds.minY - bounds.height / 2) * scale
        ]);
        const trace = polygon => {
            ctx.beginPath();
            for (const [x, y] of polygon) ctx.lineTo(x, y);
            ctx.closePath();
        };
        const outline = points(full);
        ctx.clearRect(0, 0, width, height);
        trace(outline);
        ctx.strokeStyle = '#8b9bb5';
        ctx.setLineDash([3, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (vertices.length) {
            trace(points(vertices));
            ctx.fillStyle = '#80b9e8';
            ctx.fill();
        }
        ctx.fillStyle = '#e0e8f3';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        outline.forEach(([x, y], side) => {
            const next = outline[(side + 1) % 6];
            const midX = (x + next[0]) / 2;
            const midY = (y + next[1]) / 2;
            ctx.fillText(String(side + 1), width / 2 + (midX - width / 2) * 1.27, height / 2 + (midY - height / 2) * 1.27);
        });
    }
}

function dimensions({ width, height }) {
    const format = new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 1 });
    return { width: format.format(width), height: format.format(height) };
}
