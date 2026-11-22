import HexMath from './hex-math.js';
import FrameGenerator from './frame-generator.js';
import { i18n } from './i18n.js?v=1.0.3';
import { cellKey } from './grid-topology.js';

const ROW_RENDER_BUDGET_MS = 7;
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

function dimensions({ width, height }) {
    const format = new Intl.NumberFormat(i18n.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return `${format.format(width)} × ${format.format(height)} mm`;
}

function drawPath(ctx, polygon, project) {
    for (const [index, point] of polygon.entries()) {
        const { x, y } = project(point);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
}

function describeShape(cell) {
    if (cell.shape?.kind === 'legacy') return i18n.t('shape_legacy');
    const depths = cell.shape?.depths;
    if (!depths) return i18n.t('shape_full');
    const cuts = depths.flatMap((depth, side) => depth ? [i18n.t('shape_cut_detail', { side: side + 1, depth })] : []);
    const type = cuts.length === 1 && depths.includes(50) ? 'shape_half' : 'shape_cuts';
    return `${i18n.t(type)} · ${cuts.join(', ')}`;
}

export default class AssemblyGuide {
    constructor(grid, processor) {
        this.grid = grid;
        this.processor = processor;
        this.revision = 0;
        this.rendered = -1;
        this.pending = null;
        this.tab = document.getElementById('tab-instructions');
        this.tbody = document.getElementById('instructions-table-body');
        this.map = document.getElementById('instruction-layout-canvas');
    }

    invalidate() {
        this.revision++;
        if (!this.tab.classList.contains('hidden')) this.refresh();
    }

    refresh() {
        this.render().catch(error => this.showError(error));
    }

    showError(error) {
        console.error(error);
        const row = this.tbody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 5;
        cell.textContent = i18n.t('guide_error');
        this.tbody.replaceChildren(row);
    }

    async print() {
        try {
            // Recheck after each awaited generation so a simultaneous edit cannot
            // leave a stale or partly populated guide in the print dialog.
            while (this.rendered !== this.revision) await this.render();
            window.print();
        } catch (error) {
            this.showError(error);
        }
    }

    render() {
        if (this.rendered === this.revision) return Promise.resolve();
        if (this.pending?.revision === this.revision) return this.pending.task;
        const revision = this.revision;
        const task = this.renderRevision(revision).finally(() => {
            if (this.pending?.revision !== revision) return;
            this.pending = null;
            this.tbody.removeAttribute('aria-busy');
        });
        this.pending = { revision, task };
        return task;
    }

    async renderRevision(revision) {
        this.tbody.setAttribute('aria-busy', 'true');
        await nextFrame();
        if (revision !== this.revision) return;
        const { grid } = this;
        const cells = grid.getActiveCells().sort((a, b) => a.row - b.row || a.col - b.col);
        const { frameEnable, frameWidth, frameClearance, hexSize, orientation, gap } = grid.config;
        const frameType = document.getElementById('frame-type').value;
        const frameColor = document.getElementById('frame-color').value;
        const panels = new Map();
        grid.panelExport.groups.forEach((group, index) => {
            for (const { q, r } of group.cells) panels.set(cellKey(q, r), index + 1);
        });
        const items = cells.map(cell => ({
            cell,
            tile: grid.getCellVertices(cell),
            frame: frameEnable ? FrameGenerator.getFrameVerticesMm(cell, grid, frameWidth, frameClearance) : null,
            panel: panels.get(cellKey(cell.q, cell.r))
        }));
        document.getElementById('inst-stat-total').textContent = cells.length;
        document.getElementById('inst-stat-dimensions').textContent = dimensions(grid.getBoundingBoxMm());
        document.getElementById('inst-stat-hexsize').textContent = `${hexSize} mm`;
        document.getElementById('inst-stat-gap').textContent = `${gap} mm`;
        this.drawMap(items);

        const nominal = HexMath.getHexDimensions(hexSize, orientation);
        const thumbnailDpi = Math.min(100, 72 * 25.4 / Math.max(nominal.width, nominal.height));
        const thumbnailGrid = { config: { ...grid.config, dpi: thumbnailDpi } };
        this.tbody.replaceChildren();
        if (cells.length === 0) {
            const empty = this.tbody.insertRow().insertCell();
            empty.colSpan = 5;
            empty.textContent = i18n.t('no_active_hexes');
        }
        let index = 0;
        while (index < items.length) {
            if (revision !== this.revision) return;
            const rows = document.createDocumentFragment();
            const deadline = performance.now() + ROW_RENDER_BUDGET_MS;
            do {
                rows.append(this.buildRow(items[index++], { thumbnailGrid, frameType, frameColor }));
            } while (index < items.length && performance.now() < deadline);
            this.tbody.append(rows);
            if (index < items.length) await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (revision === this.revision) this.rendered = revision;
    }

    buildRow({ cell, tile, frame, panel }, { thumbnailGrid, frameType, frameColor }) {
        const row = document.createElement('tr');
        const code = document.createElement('th');
        code.scope = 'row';
        code.textContent = cell.label;
        row.append(code);

        const position = row.insertCell();
        const displayIndex = index => index < 0 ? index : index + 1;
        position.textContent = i18n.t('guide_position', { col: displayIndex(cell.col), row: displayIndex(cell.row) });
        if (panel) this.appendDetail(position, i18n.t('panel_group_name', { number: panel }));

        const image = this.processor.getImage(cell.imageId);
        const graphicColumn = row.insertCell();
        const graphic = image ? this.processor.createHexagonCanvas(cell, thumbnailGrid) : null;
        if (graphic) {
            graphic.setAttribute('role', 'img');
            graphic.setAttribute('aria-label', i18n.t('guide_graphic_preview', { code: cell.label }));
            graphicColumn.append(graphic);
        } else {
            graphicColumn.textContent = i18n.t(image ? 'gen_error' : 'no_graphic');
        }

        const frameColumn = row.insertCell();
        if (frame?.outerVerticesMm.length) frameColumn.append(this.frameThumbnail(cell, frame, frameType, frameColor));
        else frameColumn.textContent = i18n.t(frame ? 'gen_error' : 'frames_disabled');

        const details = row.insertCell();
        this.appendDetail(details, `${i18n.t('th_graphic')} · ${dimensions(HexMath.getPolygonBounds(tile))}`);
        this.appendDetail(details, describeShape(cell));
        if (frame?.outerVerticesMm.length) {
            this.appendDetail(details, `${i18n.t('guide_frame')} · ${dimensions(HexMath.getPolygonBounds(frame.outerVerticesMm))}`);
        }
        if (image) {
            const name = document.createElement('code');
            name.textContent = image.name;
            details.append(name);
        }
        return row;
    }

    appendDetail(parent, text) {
        const line = document.createElement('div');
        line.textContent = text;
        parent.append(line);
    }

    frameThumbnail(cell, { innerVerticesMm, outerVerticesMm }, type, color) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 72;
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', i18n.t('guide_frame_preview', { code: cell.label }));
        const ctx = canvas.getContext('2d');
        const { minX, minY, width, height } = HexMath.getPolygonBounds(outerVerticesMm);
        const scale = 66 / Math.max(width, height);
        const project = ({ x, y }) => ({
            x: (x - minX - width / 2) * scale + 36,
            y: (y - minY - height / 2) * scale + 36
        });
        ctx.fillStyle = color;
        ctx.beginPath();
        drawPath(ctx, outerVerticesMm, project);
        if (type === 'outline') drawPath(ctx, innerVerticesMm, project);
        ctx.fill('evenodd');
        ctx.strokeStyle = '#62666c';
        ctx.stroke();
        if (type === 'sleeve') {
            ctx.beginPath();
            drawPath(ctx, innerVerticesMm, project);
            ctx.strokeStyle = '#a9a9a9';
            ctx.stroke();
        }
        return canvas;
    }

    drawMap(items) {
        const ctx = this.map.getContext('2d');
        if (!items.length) {
            this.map.width = this.map.height = 1;
            this.map.parentElement.hidden = true;
            return;
        }
        this.map.parentElement.hidden = false;
        const bounds = HexMath.getPolygonBounds(items.flatMap(({ tile, frame }) => [...tile, ...(frame?.outerVerticesMm ?? [])]));
        const scale = 1700 / Math.max(bounds.width, bounds.height);
        const padding = 20;
        this.map.width = Math.ceil(bounds.width * scale + padding * 2);
        this.map.height = Math.ceil(bounds.height * scale + padding * 2);
        const project = ({ x, y }) => ({ x: (x - bounds.minX) * scale + padding, y: (y - bounds.minY) * scale + padding });
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const { tile, frame, cell } of items) {
            if (!tile.length) continue;
            if (frame?.outerVerticesMm.length) {
                ctx.beginPath();
                drawPath(ctx, frame.outerVerticesMm, project);
                ctx.strokeStyle = '#222';
                ctx.stroke();
            }
            ctx.beginPath();
            drawPath(ctx, tile, project);
            ctx.fillStyle = '#f1f3f5';
            ctx.fill();
            ctx.strokeStyle = '#59616c';
            ctx.lineWidth = 1.2;
            ctx.stroke();
            const center = tile.reduce((sum, point) => ({
                x: sum.x + point.x / tile.length, y: sum.y + point.y / tile.length
            }), { x: 0, y: 0 });
            const { x, y } = project(center);
            const { width, height } = HexMath.getPolygonBounds(tile);
            ctx.font = `600 ${Math.max(13, Math.min(55, height * scale * 0.25))}px sans-serif`;
            ctx.fillStyle = '#111';
            ctx.fillText(cell.label, x, y, Math.max(12, width * scale * 0.78));
        }
    }
}
