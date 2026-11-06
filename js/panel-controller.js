import HexMath from './hex-math.js?v=1.0.3';
import { i18n } from './i18n.js?v=1.0.3';
import { upsertPanelGroup, removePanelGroup } from './panel-groups.js';
import { getPanelGeometry } from './panel-export.js';

const COLORS = ['#ffbf47', '#f575be', '#a2dc54', '#ba91ff', '#ff9275', '#75d9ed'];
const keyOf = cell => `${cell.q},${cell.r}`;

/** Owns the temporary selection and controls for persistent PNG panel groups. */
export default class PanelController {
    constructor({ gridManager, planner, onChange, canEdit, exporter }) {
        this.grid = gridManager;
        this.planner = planner;
        this.onChange = onChange;
        this.canEdit = canEdit;
        this.exporter = exporter;
        this.selected = new Set();
        this.editingId = null;
        this.messageKey = null;
        this.messageParams = {};
        this.list = document.getElementById('panel-groups-list');
        this.gapInput = document.getElementById('panel-gap-mm');
        this.status = document.getElementById('panel-selection-status');
        this.message = document.getElementById('panel-group-message');
        this.saveButton = document.getElementById('btn-panel-save');
        this.modeButtons = {
            grid: document.getElementById('btn-mode-grid'),
            image: document.getElementById('btn-mode-image'),
            groups: document.getElementById('btn-mode-groups')
        };
        this.planner.panelController = this;

        Object.entries(this.modeButtons).forEach(([mode, button]) => {
            button?.addEventListener('click', () => this.setMode(mode));
        });
        this.saveButton?.addEventListener('click', () => this.save());
        document.getElementById('btn-panel-cancel')?.addEventListener('click', () => {
            if (!this.canEdit()) return;
            this.resetSelection();
            this.refresh();
        });
        const updateGap = finalize => {
            if (!this.canEdit() || !this.grid.panelExport) return;
            const raw = this.gapInput.value.trim();
            if (!finalize && (raw === '' || !Number.isFinite(Number(raw)))) return;
            const value = raw === '' ? 0 : Number(raw);
            const gap = Number.isFinite(value) ? Math.min(50, Math.max(0, value)) : 0;
            if (finalize) this.gapInput.value = String(gap);
            if (gap === this.grid.panelExport.gapMm) return;
            this.grid.panelExport.gapMm = gap;
            this.onChange();
            this.refresh();
        };
        this.gapInput?.addEventListener('input', () => updateGap(false));
        this.gapInput?.addEventListener('change', () => updateGap(true));
        document.getElementById('btn-export-groups')?.addEventListener('click', () => {
            this.exporter.exportGroupsZip();
        });
        document.addEventListener('languagechange', () => this.refresh());
    }

    setMode(mode) {
        if (!this.modeButtons[mode] || (mode === 'groups' && !this.canEdit())) return;
        this.planner.interactionMode = mode;
        for (const [name, button] of Object.entries(this.modeButtons)) {
            button?.classList.toggle('active', name === mode);
            button?.setAttribute('aria-pressed', String(name === mode));
        }
        if (mode === 'groups') {
            const status = document.getElementById('canvas-status-text');
            if (status) status.textContent = i18n.t('status_groups_mode');
        }
        this.planner.scheduleRender();
    }

    selectCell(cell) {
        if (!this.canEdit() || !cell?.enabled) return;
        const key = keyOf(cell);
        if (this.selected.has(key)) this.selected.delete(key);
        else this.selected.add(key);
        this.planner.selectedCellKey = key;
        this.planner.hoveredCellKey = key;
        this.messageKey = null;
        this.refresh();
        const live = document.getElementById('planner-live-status');
        if (live) live.textContent = i18n.t('panel_selected', { cells: this.selectedLabels().join(', ') || '–' });
    }

    selectedLabels() {
        return this.grid.getAllCells()
            .filter(cell => this.selected.has(keyOf(cell)))
            .sort((a, b) => a.col - b.col || a.row - b.row)
            .map(cell => cell.label);
    }

    resetSelection() {
        this.selected.clear();
        this.editingId = null;
        this.messageKey = null;
        this.planner.scheduleRender();
    }

    save() {
        if (!this.canEdit() || !this.grid.panelExport) return;
        const cells = [...this.selected].map(key => {
            const [q, r] = key.split(',').map(Number);
            return { q, r };
        });
        try {
            upsertPanelGroup(this.grid.panelExport, cells, this.grid, this.editingId);
            this.resetSelection();
            this.onChange();
        } catch (error) {
            this.messageKey = ({
                PANEL_DISCONNECTED: 'panel_error_disconnected',
                PANEL_CELL_CONFLICT: 'panel_error_conflict',
                PANEL_INVALID_CELLS: 'panel_error_invalid_cells',
                PANEL_CELL_UNAVAILABLE: 'panel_error_invalid_cells'
            })[error.code] || 'panel_error_generic';
            this.messageParams = {};
        }
        this.refresh();
    }

    edit(id) {
        if (!this.canEdit()) return;
        const group = this.grid.panelExport?.groups.find(item => item.id === id);
        if (!group) return;
        this.editingId = id;
        this.selected = new Set(group.cells.map(keyOf));
        this.messageKey = null;
        this.setMode('groups');
        this.refresh();
        this.planner.canvas.focus({ preventScroll: true });
    }

    remove(id) {
        if (!this.canEdit() || !this.grid.panelExport) return;
        removePanelGroup(this.grid.panelExport, id);
        if (this.editingId === id) this.resetSelection();
        this.onChange();
        this.refresh();
    }

    notifyRemoved(count) {
        if (!count) return;
        this.messageKey = 'panel_removed';
        this.messageParams = { count };
        if (this.editingId && !this.grid.panelExport.groups.some(group => group.id === this.editingId)) {
            this.selected.clear();
            this.editingId = null;
        }
        this.refresh();
    }

    refresh() {
        const state = this.grid.panelExport || { gapMm: 0, groups: [] };
        if (this.gapInput && document.activeElement !== this.gapInput) this.gapInput.value = String(state.gapMm);
        const labels = this.selectedLabels().join(', ') || '–';
        const index = state.groups.findIndex(group => group.id === this.editingId);
        if (this.status) this.status.textContent = index >= 0
            ? i18n.t('panel_editing', { number: index + 1, cells: labels })
            : i18n.t('panel_selected', { cells: labels });
        if (this.saveButton) this.saveButton.textContent = i18n.t(index >= 0 ? 'panel_save_edit' : 'panel_save');
        if (this.message) this.message.textContent = this.messageKey ? i18n.t(this.messageKey, this.messageParams) : '';
        if (this.list) {
            this.list.replaceChildren();
            if (!state.groups.length) {
                const empty = document.createElement('p');
                empty.className = 'field-info';
                empty.textContent = i18n.t('panel_groups_empty');
                this.list.append(empty);
            }
            state.groups.forEach((group, groupIndex) => {
                const row = document.createElement('div');
                row.className = 'panel-group-row';
                row.dataset.groupId = group.id;
                const summary = document.createElement('div');
                summary.className = 'panel-group-summary';
                const title = document.createElement('strong');
                title.textContent = i18n.t('panel_group_name', { number: groupIndex + 1 });
                title.style.color = COLORS[groupIndex % COLORS.length];
                const detail = document.createElement('span');
                const cells = group.cells.map(({ q, r }) => this.grid.getCell(q, r)).filter(Boolean)
                    .sort((a, b) => a.col - b.col || a.row - b.row);
                let dimensions = '';
                try {
                    const { bbox } = getPanelGeometry(group, this.grid, state.gapMm);
                    dimensions = ` · ${bbox.width.toFixed(2)} × ${bbox.height.toFixed(2)} mm`;
                } catch { /* A pending grid change will reconcile invalid groups. */ }
                detail.textContent = cells.map(cell => cell.label).join(', ') + dimensions;
                summary.append(title, detail);
                const actions = document.createElement('div');
                actions.className = 'panel-group-actions';
                for (const [action, handler] of [['edit', () => this.edit(group.id)], ['delete', () => this.remove(group.id)]]) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'btn btn-secondary btn-sm';
                    button.dataset.action = action;
                    button.textContent = i18n.t(`panel_${action}`);
                    button.setAttribute('aria-label', `${button.textContent}: ${title.textContent}`);
                    button.disabled = !this.canEdit();
                    button.addEventListener('click', handler);
                    actions.append(button);
                }
                row.append(summary, actions);
                this.list.append(row);
            });
        }
        this.planner.scheduleRender();
    }

    drawOverlay(ctx) {
        const state = this.grid.panelExport;
        if (!state) return;
        ctx.save();
        state.groups.forEach((group, index) => {
            const color = COLORS[index % COLORS.length];
            for (const { q, r } of group.cells) {
                const cell = this.grid.getCell(q, r);
                if (!cell?.enabled) continue;
                const vertices = HexMath.getCellVertices(cell, this.grid.config).map(v => this.planner.worldToScreen(v.x, v.y));
                if (vertices.length < 3) continue;
                ctx.beginPath();
                vertices.forEach((v, i) => i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y));
                ctx.closePath();
                ctx.strokeStyle = color;
                ctx.lineWidth = 3;
                ctx.stroke();
                const center = vertices.reduce((sum, v) => ({ x: sum.x + v.x / vertices.length, y: sum.y + v.y / vertices.length }), { x: 0, y: 0 });
                ctx.fillStyle = '#161b22';
                ctx.fillRect(center.x - 10, center.y + 11, 20, 16);
                ctx.fillStyle = color;
                ctx.font = 'bold 11px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(String(index + 1), center.x, center.y + 19);
            }
        });
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        for (const key of this.selected) {
            const cell = this.grid.getCell(...key.split(',').map(Number));
            if (!cell?.enabled) continue;
            const vertices = HexMath.getCellVertices(cell, this.grid.config).map(v => this.planner.worldToScreen(v.x, v.y));
            if (vertices.length < 3) continue;
            ctx.beginPath();
            vertices.forEach((v, i) => i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y));
            ctx.closePath();
            ctx.stroke();
        }
        ctx.restore();
    }
}
