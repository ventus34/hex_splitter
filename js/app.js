import GridManager from './grid-manager.js?v=1.0.3';
import ImageProcessor from './image-processor.js?v=1.0.3';
import WallPlanner from './wall-planner.js?v=1.0.3';
import PreviewRenderer from './preview-renderer.js?v=1.0.3';
import ExportManager from './export-manager.js?v=1.0.3';
import HangerGenerator from './hanger-generator.js?v=1.0.3';
import { i18n } from './i18n.js?v=1.0.3';
import DBStore from './project-store.js?v=1.0.3';
import ProjectSession from './project-session.js?v=1.0.3';
import HistoryController from './history-controller.js';
import { applyLayoutFields } from './project-layout.js';
import { createProjectArchiveEntries } from './project-archive.js';
import { waitForArchiveTask } from './archive-output.js';
import {
    PROJECT_LIMITS,
    assertImageDimensions,
    normalizeProjectImageBlob,
    parseBoundedNumber,
    validateProjectArchiveMetadata,
    validateProjectLayout
} from './project-validation.js?v=1.0.3';

document.addEventListener('DOMContentLoaded', async () => {
    let projectSession = null;
    let projectReady = false;
    let projectLoadPromise = null;
    let historyRestorePromise = null;
    let historyController = null;
    const activeProjectOperations = new Set();
    const projectOperationFailures = [];
    const PROJECT_OPERATION_DRAIN_TIMEOUT_MS = 35_000;
    let projectResetInProgress = false;

    function trackProjectOperation(operation) {
        const task = Promise.resolve().then(operation);
        activeProjectOperations.add(task);
        task.then(
            () => activeProjectOperations.delete(task),
            error => {
                activeProjectOperations.delete(task);
                projectOperationFailures.push(error);
            }
        );
        return task;
    }

    async function waitForProjectOperations(tasks, timeoutMs = PROJECT_OPERATION_DRAIN_TIMEOUT_MS) {
        if (tasks.length === 0) return;
        let timeoutId;
        const timeout = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Operacje projektu nie zakończyły się w wymaganym czasie.')), timeoutMs);
        });
        try {
            const result = await Promise.race([Promise.allSettled(tasks), timeout]);
            const failure = result.find(entry => entry.status === 'rejected');
            if (failure) throw new Error('Nie udało się bezpiecznie zakończyć operacji projektu.', { cause: failure.reason });
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async function drainProjectOperations() {
        if (projectOperationFailures.length > 0) {
            const error = projectOperationFailures.shift();
            projectOperationFailures.length = 0;
            throw new Error('Nie udało się bezpiecznie zakończyć operacji projektu.', { cause: error });
        }

        const deadline = Date.now() + PROJECT_OPERATION_DRAIN_TIMEOUT_MS;
        while (activeProjectOperations.size > 0) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('Operacje projektu nie zakończyły się w wymaganym czasie.');
            await waitForProjectOperations([...activeProjectOperations], remaining);
        }

        if (projectOperationFailures.length > 0) {
            const error = projectOperationFailures.shift();
            projectOperationFailures.length = 0;
            throw new Error('Nie udało się bezpiecznie zakończyć operacji projektu.', { cause: error });
        }
    }

    async function drainAndFlushProjectState() {
        await drainProjectOperations();
        return flushProjectState();
    }

    function canEditProject() {
        return projectReady && Boolean(projectSession?.isOwner);
    }
    window.canEditProject = canEditProject;

    // Inicjalizacja modułów
    const gridManager = new GridManager();
    const imageProcessor = new ImageProcessor();
    const planner = new WallPlanner('planner-canvas', gridManager, imageProcessor);
    const preview = new PreviewRenderer('preview-canvas', gridManager, imageProcessor);
    const exporter = new ExportManager(gridManager, imageProcessor);
    document.getElementById('btn-cancel-export')?.addEventListener('click', () => exporter.cancel());

    // Expose for testing
    window.gridManager = gridManager;
    window.imageProcessor = imageProcessor;
    window.planner = planner;
    window.preview = preview;

    // Dynamiczne wskaźniki wymiarów pojedynczego heksa
    const valHexFlatWidth = document.getElementById('val-hex-flat-width');
    const valHexTotalHeight = document.getElementById('val-hex-total-height');

    // Język i i18n
    const selectLang = document.getElementById('select-lang');
    if (selectLang) {
        selectLang.value = i18n.locale;
        selectLang.addEventListener('change', (e) => {
            i18n.setLocale(e.target.value);
        });
    }
    i18n.translatePage();

    // Elementy DOM konfiguracji siatki
    const inputCols = document.getElementById('grid-cols');
    const inputRows = document.getElementById('grid-rows');
    const inputHexSize = document.getElementById('hex-size');
    const selectOrientation = document.getElementById('hex-orientation');
    const selectStagger = document.getElementById('hex-stagger');
    const inputGap = document.getElementById('hex-gap');
    const selectDpi = document.getElementById('export-dpi');
    const selectFormat = document.getElementById('export-format');
    const inputQuality = document.getElementById('export-quality');
    const valQuality = document.getElementById('val-export-quality');
    const jpgQualityGroup = document.getElementById('jpg-quality-group');
    const chkHalfHexes = document.getElementById('grid-half-hexes');

    // Elementy DOM weryfikacji stołu
    const chkBedVerify = document.getElementById('bed-verify');
    const inputBedX = document.getElementById('bed-size-x');
    const inputBedY = document.getElementById('bed-size-y');
    const bedWarningMessage = document.getElementById('bed-warning-message');

    // Elementy DOM konfiguracji ramek i złączy
    const chkFrameEnable = document.getElementById('frame-enable');
    const selectFrameType = document.getElementById('frame-type');
    const inputFrameWidth = document.getElementById('frame-width');
    const inputFrameClearance = document.getElementById('frame-clearance');
    const inputFrameHeight = document.getElementById('frame-height');
    const inputFrameSleeveBase = document.getElementById('frame-sleeve-base');
    const inputFrameColor = document.getElementById('frame-color');
    const txtFrameColorHex = document.getElementById('frame-color-hex');
    const frameSettingsSub = document.querySelector('.frame-settings-sub');
    const chkSyncFrameWidth = document.getElementById('chk-sync-frame-width');

    // Elementy DOM konfiguracji reliefu 3D
    const chkReliefEnable = document.getElementById('relief-enable');
    const inputReliefHeight = document.getElementById('relief-height');
    const inputReliefBaseThickness = document.getElementById('relief-base-thickness');
    const chkReliefInvert = document.getElementById('relief-invert');
    const inputReliefSectors = document.getElementById('relief-sectors');
    const inputReliefRings = document.getElementById('relief-rings');
    const inputReliefBlur = document.getElementById('relief-blur');
    const valReliefBlur = document.getElementById('val-relief-blur');
    const reliefSettingsSub = document.querySelector('.relief-settings-sub');
    const btnExport3dHexesStl = document.getElementById('btn-export-3d-hexes-stl');

    // Elementy biblioteki obrazów
    const fileInput = document.getElementById('file-input');
    const dropzone = document.getElementById('dropzone');
    const imageList = document.getElementById('image-list');
    const selectMainImage = document.getElementById('select-main-image');
    const singleImageWrapper = document.querySelector('.single-image-select-wrapper');
    const inputSingleImageZoom = document.getElementById('single-image-zoom');
    const valSingleImageZoom = document.getElementById('val-single-image-zoom');
    const singleImageZoomGroup = document.getElementById('single-image-zoom-group');

    // Zmienne stanu trybu dopasowania
    const radioImageModes = document.querySelectorAll('input[name="image-mode"]');

    // Opcje podglądu AMS
    const chkPreviewAms = document.getElementById('chk-preview-ams');
    const selectAmsColors = document.getElementById('preview-ams-colors');

    // Przełączniki trybów pracy
    const btnModeGrid = document.getElementById('btn-mode-grid');
    const btnModeImage = document.getElementById('btn-mode-image');

    // Elementy miarki
    const chkPreviewRuler = document.getElementById('chk-preview-ruler');

    // Wizualizacja uchwytów
    const chkPreviewHangers = document.getElementById('chk-preview-hangers');

    // Elementy DOM uchwytu 3D
    const inputHangerClearance = document.getElementById('hanger-clearance');
    const inputHangerBaseThickness = document.getElementById('hanger-base-thickness');
    const inputHangerRidgeHeight = document.getElementById('hanger-ridge-height');
    const inputHangerArmWidth = document.getElementById('hanger-arm-width');
    const inputHangerArmLength = document.getElementById('hanger-arm-length');
    const btnExportHanger = document.getElementById('btn-export-hanger');

    // Zabezpieczenie
    if (!inputCols || !inputRows || !inputHexSize || !selectOrientation || !selectStagger || !inputGap || !selectDpi) {
        console.error("Nie znaleziono wymaganych elementów konfiguracji w DOM.");
        return;
    }

    // Inicjalizacja konfiguracji
    function readNumberInput(input, fallback, min, max, integer = false) {
        let value = parseBoundedNumber(input?.value, fallback, min, max);
        if (integer) value = Math.round(value);
        return value;
    }

    function normalizeNumericInput(input) {
        const min = input.min === '' ? -Infinity : Number(input.min);
        const max = input.max === '' ? Infinity : Number(input.max);
        const defaultValue = Number(input.defaultValue);
        const fallback = Number.isFinite(defaultValue) ? defaultValue : (Number.isFinite(min) ? min : 0);
        const normalized = readNumberInput(input, fallback, min, max, input.step === '1');
        input.value = String(normalized);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    document.querySelectorAll('input[type="number"]').forEach(input => {
        input.addEventListener('change', () => normalizeNumericInput(input));
    });

    function readConfigFromUI() {
        return {
            columns: readNumberInput(inputCols, 4, 1, 25, true),
            rows: readNumberInput(inputRows, 3, 1, 25, true),
            hexSize: readNumberInput(inputHexSize, 100, 10, 500),
            orientation: selectOrientation.value || 'flat-top',
            stagger: selectStagger.value || 'left',
            gap: readNumberInput(inputGap, 2, 0, 50),
            dpi: selectDpi.value === 'original' ? 'original' : readNumberInput(selectDpi, 300, 72, 1200, true),
            exportFormat: selectFormat.value || 'png',
            exportQuality: readNumberInput(inputQuality, 90, 10, 100) / 100,
            bedX: readNumberInput(inputBedX, 256, 50, 1000),
            bedY: readNumberInput(inputBedY, 256, 50, 1000),
            bedVerify: chkBedVerify.checked,
            frameEnable: chkFrameEnable.checked,
            frameWidth: readNumberInput(inputFrameWidth, 2, 1, 50),
            frameClearance: readNumberInput(inputFrameClearance, 0.2, 0, 5),
            frameHeight: readNumberInput(inputFrameHeight, 10, 1, 100),
            frameSleeveBase: readNumberInput(inputFrameSleeveBase, 1.2, 0.4, 20),
            singleImageOffsetX: parseBoundedNumber(gridManager.config.singleImageOffsetX, 0, -100_000, 100_000),
            singleImageOffsetY: parseBoundedNumber(gridManager.config.singleImageOffsetY, 0, -100_000, 100_000),
            singleImageScale: readNumberInput(inputSingleImageZoom, 100, 100, 500) / 100,
            halfHexes: chkHalfHexes?.checked || false
        };
    }

    function updateFrameWidthSync() {
        if (chkSyncFrameWidth) {
            if (chkSyncFrameWidth.checked) {
                inputFrameWidth.value = Math.max(1, parseBoundedNumber(inputGap.value, 2, 0, 50));
                inputFrameWidth.disabled = true;
            } else {
                inputFrameWidth.disabled = false;
            }
        }
    }



    function updateHexDimensionLabels() {
        const size = readNumberInput(inputHexSize, 100, 10, 500);
        const orientation = selectOrientation.value;

        if (orientation === 'flat-top') {
            valHexFlatWidth.textContent = Math.round(size * Math.sqrt(3));
            valHexTotalHeight.textContent = Math.round(size * 2);
        } else {
            valHexFlatWidth.textContent = Math.round(size * Math.sqrt(3));
            valHexTotalHeight.textContent = Math.round(size * 2);
        }
    }

    function buildProjectLayout() {
        const config = readConfigFromUI();
        return {
            grid: {
                columns: config.columns,
                rows: config.rows,
                hexSize: config.hexSize,
                orientation: selectOrientation.value,
                stagger: selectStagger.value,
                gap: config.gap,
                dpi: selectDpi.value,
                exportFormat: selectFormat.value,
                exportQuality: Math.round(config.exportQuality * 100),
                singleImageOffsetX: config.singleImageOffsetX,
                singleImageOffsetY: config.singleImageOffsetY,
                singleImageScale: config.singleImageScale,
                halfHexes: chkHalfHexes?.checked || false
            },
            bed: {
                verify: chkBedVerify.checked,
                sizeX: config.bedX,
                sizeY: config.bedY
            },
            frame: {
                enable: chkFrameEnable.checked,
                type: selectFrameType.value,
                width: config.frameWidth,
                clearance: config.frameClearance,
                height: config.frameHeight,
                sleeveBase: config.frameSleeveBase,
                color: inputFrameColor.value,
                syncWidth: chkSyncFrameWidth ? chkSyncFrameWidth.checked : true
            },
            relief: {
                enable: chkReliefEnable.checked,
                height: readNumberInput(inputReliefHeight, 2, 0.1, 50),
                baseThickness: readNumberInput(inputReliefBaseThickness, 1.2, 0.4, 50),
                invert: chkReliefInvert.checked,
                sectors: readNumberInput(inputReliefSectors, 120, 30, 360, true),
                rings: readNumberInput(inputReliefRings, 60, 15, 180, true),
                blur: readNumberInput(inputReliefBlur, 1.5, 0, 5)
            },
            hanger: {
                clearance: readNumberInput(inputHangerClearance, 0.3, 0, 5),
                baseThickness: readNumberInput(inputHangerBaseThickness, 1.2, 0.5, 10),
                ridgeHeight: readNumberInput(inputHangerRidgeHeight, 2, 1, 20),
                armWidth: readNumberInput(inputHangerArmWidth, 12, 5, 100),
                armLength: readNumberInput(inputHangerArmLength, 30, 10, 200)
            },
            previewOptions: {
                showGaps: chkPreviewGaps.checked,
                showLabels: chkPreviewLabels.checked,
                showFrames: chkPreviewFrames.checked,
                showRuler: chkPreviewRuler ? chkPreviewRuler.checked : true,
                showHangers: chkPreviewHangers ? chkPreviewHangers.checked : false,
                background: selectPreviewBg.value
            },
            imageMode: getActiveImageMode(),
            activeImageId: imageProcessor.activeImageId,
            cells: gridManager.getAllCells().map(c => ({
                q: c.q,
                r: c.r,
                enabled: c.enabled,
                imageId: c.imageId,
                cropRegion: c.cropRegion,
                groupId: c.groupId,
                groupShiftX: c.groupShiftX,
                groupShiftY: c.groupShiftY,
                groupZoom: c.groupZoom
            }))
        };
    }

    // Automatyczny zapis: szybki fallback w localStorage i grupowany zapis IndexedDB.
    let layoutSaveTimer = null;
    let lastLayoutTimestamp = 0;
    let persistedLayoutTimestamp = 0;
    let projectImportInProgress = false;
    function makeSavedLayoutSnapshot() {
        const layoutData = JSON.parse(JSON.stringify(buildProjectLayout()));
        lastLayoutTimestamp = Math.max(Date.now(), lastLayoutTimestamp + 1);
        layoutData.savedAt = lastLayoutTimestamp;
        return layoutData;
    }

    function saveLayoutBackup(layoutData, { committed = false } = {}) {
        if (!projectSession?.canWrite) return;
        try {
            const previousRevision = persistedLayoutTimestamp;
            if (committed) persistedLayoutTimestamp = Math.max(persistedLayoutTimestamp, layoutData.savedAt ?? 0);
            const existing = JSON.parse(localStorage.getItem('hexsplitter_project_layout') || 'null');
            // An earlier transaction may finish after the user has already made another edit.
            if (committed && existing?.savedAt > layoutData.savedAt) {
                if (existing.backupBaseSavedAt === previousRevision) {
                    existing.backupBaseSavedAt = persistedLayoutTimestamp;
                    localStorage.setItem('hexsplitter_project_layout', JSON.stringify(existing));
                }
                return;
            }
            localStorage.setItem('hexsplitter_project_layout', JSON.stringify({
                ...layoutData, backupBaseSavedAt: persistedLayoutTimestamp
            }));
        } catch (error) {
            console.warn('Nie udało się zapisać kopii układu w localStorage.', error);
        }
    }

    function saveProjectState() {
        if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
        const layoutData = makeSavedLayoutSnapshot();
        historyController?.record(getHistorySnapshot(layoutData));
        saveLayoutBackup(layoutData);
        if (layoutSaveTimer !== null) clearTimeout(layoutSaveTimer);
        layoutSaveTimer = setTimeout(() => {
            layoutSaveTimer = null;
            if (!canEditProject()) return;
            DBStore.saveLayout(layoutData)
                .then(() => saveLayoutBackup(layoutData, { committed: true }))
                .catch(error => console.error('Nie udało się utrwalić układu projektu.', error));
        }, 300);
    }

    async function flushProjectState() {
        if (projectLoadPromise && !projectReady) await projectLoadPromise;
        if (historyRestorePromise) await historyRestorePromise.catch(() => {});
        if (!projectSession?.canWrite || projectImportInProgress) return false;
        if (layoutSaveTimer !== null) {
            clearTimeout(layoutSaveTimer);
            layoutSaveTimer = null;
        }
        const layoutData = makeSavedLayoutSnapshot();
        await DBStore.saveLayout(layoutData);
        saveLayoutBackup(layoutData, { committed: true });
        return true;
    }

    function checkBedVolumeAlert() {
        const activeCells = gridManager.getActiveCells();
        const hasExceeding = activeCells.some(c => c.exceedsBedSize);
        
        if (hasExceeding && chkBedVerify.checked) {
            bedWarningMessage.classList.remove('hidden');
        } else {
            bedWarningMessage.classList.add('hidden');
        }
    }

    // Aktualizacja etykiet opcji stagger w zależności od orientacji
    function updateStaggerDropdownLabels() {
        const orientation = selectOrientation.value;
        const optLeft = document.getElementById('opt-stagger-left');
        const optRight = document.getElementById('opt-stagger-right');
        if (optLeft && optRight) {
            if (orientation === 'pointy-top') {
                optLeft.setAttribute('data-i18n', 'stagger_left_pointy');
                optRight.setAttribute('data-i18n', 'stagger_right_pointy');
            } else {
                optLeft.setAttribute('data-i18n', 'stagger_left_flat');
                optRight.setAttribute('data-i18n', 'stagger_right_flat');
            }
            i18n.translatePage();
        }
    }

    // Obsługa zmian konfiguracji siatki
    function handleGridConfigChange() {
        updateStaggerDropdownLabels();
        updateFrameWidthSync();
        gridManager.updateConfig(readConfigFromUI());
        updateHexDimensionLabels();
        checkBedVolumeAlert();
        
        const mode = getActiveImageMode();
        if (mode === 'single') {
            imageProcessor.recalculateSingleImageMapping(gridManager);
        } else if (mode === 'multi') {
            imageProcessor.recalculateMultiImageMapping(gridManager);
        } else if (mode === 'span') {
            recalculateAllGroupsMapping();
        }

        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    }

    [inputCols, inputRows, inputHexSize, selectOrientation, selectStagger, inputGap, selectDpi, chkHalfHexes].forEach(input => {
        if (input) {
            input.addEventListener('input', handleGridConfigChange);
            if (input.type === 'checkbox') {
                input.addEventListener('change', handleGridConfigChange);
            }
        }
    });

    [inputHangerClearance, inputHangerBaseThickness, inputHangerRidgeHeight, inputHangerArmWidth, inputHangerArmLength].forEach(input => {
        if (input) {
            input.addEventListener('input', () => {
                preview.scheduleRender();
                saveProjectState();
            });
        }
    });

    if (selectFormat) {
        selectFormat.addEventListener('change', () => {
            if (selectFormat.value === 'jpg') {
                jpgQualityGroup.classList.remove('hidden');
            } else {
                jpgQualityGroup.classList.add('hidden');
            }
            handleGridConfigChange();
        });
    }

    if (inputQuality) {
        inputQuality.addEventListener('input', () => {
            if (valQuality) {
                valQuality.textContent = `${inputQuality.value}%`;
            }
            handleGridConfigChange();
        });
    }

    // Weryfikacja stołu roboczego
    function handleBedVerifyChange() {
        const verify = chkBedVerify.checked;
        const container = document.querySelector('.id-bed-settings-container');
        if (verify) {
            container.classList.remove('hidden');
        } else {
            container.classList.add('hidden');
        }
        
        gridManager.updateConfig(readConfigFromUI());
        checkBedVolumeAlert();
        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    }

    chkBedVerify.addEventListener('change', handleBedVerifyChange);
    [inputBedX, inputBedY].forEach(input => {
        input.addEventListener('input', () => {
            gridManager.updateConfig(readConfigFromUI());
            checkBedVolumeAlert();
            planner.scheduleRender();
            preview.scheduleRender();
            saveProjectState();
        });
    });

    // Konfiguracja ramek i złączy
    function handleFrameConfigChange() {
        updateFrameWidthSync();
        if (chkFrameEnable.checked) {
            frameSettingsSub.classList.remove('hidden');
        } else {
            frameSettingsSub.classList.add('hidden');
        }
        
        // Pokazuj/ukrywaj grubość spodu obwoluty w zależności od wybranego typu
        const sleeveBaseContainer = document.getElementById('frame-sleeve-base-container');
        if (sleeveBaseContainer) {
            if (chkFrameEnable.checked && selectFrameType.value === 'sleeve') {
                sleeveBaseContainer.classList.remove('hidden');
            } else {
                sleeveBaseContainer.classList.add('hidden');
            }
        }

        txtFrameColorHex.textContent = inputFrameColor.value.toUpperCase();
        
        // Zaktualizuj i przelicz weryfikację stołu pod kątem ramek
        gridManager.updateConfig(readConfigFromUI());
        checkBedVolumeAlert();
        
        preview.options.showFrames = chkFrameEnable.checked;
        if (chkPreviewFrames) {
            chkPreviewFrames.checked = chkFrameEnable.checked;
        }
        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    }

    chkFrameEnable.addEventListener('change', handleFrameConfigChange);
    [selectFrameType, inputFrameWidth, inputFrameClearance, inputFrameHeight, inputFrameSleeveBase, inputFrameColor].forEach(input => {
        if (input) input.addEventListener('input', handleFrameConfigChange);
    });

    // Konfiguracja reliefu 3D
    function handleReliefConfigChange() {
        if (chkReliefEnable.checked) {
            reliefSettingsSub.classList.remove('hidden');
        } else {
            reliefSettingsSub.classList.add('hidden');
        }
        saveProjectState();
    }

    chkReliefEnable.addEventListener('change', handleReliefConfigChange);
    [inputReliefHeight, inputReliefBaseThickness, chkReliefInvert, inputReliefSectors, inputReliefRings].forEach(input => {
        if (input) {
            input.addEventListener('input', handleReliefConfigChange);
            if (input.type === 'checkbox') {
                input.addEventListener('change', handleReliefConfigChange);
            }
        }
    });

    if (inputReliefBlur) {
        inputReliefBlur.addEventListener('input', () => {
            if (valReliefBlur) {
                valReliefBlur.textContent = `${inputReliefBlur.value}px`;
            }
            handleReliefConfigChange();
        });
    }

    if (chkSyncFrameWidth) {
        chkSyncFrameWidth.addEventListener('change', () => {
            updateFrameWidthSync();
            handleGridConfigChange();
        });
    }

    // Tryb przypisania grafik (Single Image vs Multi Image vs Span)
    function getActiveImageMode() {
        let activeMode = 'single';
        radioImageModes.forEach(r => {
            if (r.checked) activeMode = r.value;
        });
        return activeMode;
    }

    function updateStatusText() {
        const canvasStatusText = document.getElementById('canvas-status-text');
        if (!canvasStatusText) return;

        if (planner.interactionMode === 'grid') {
            canvasStatusText.textContent = i18n.t('status_grid_mode');
        } else {
            const mode = getActiveImageMode();
            if (mode === 'single') {
                canvasStatusText.textContent = i18n.t('status_image_mode_single');
            } else if (mode === 'multi') {
                canvasStatusText.textContent = i18n.t('status_image_mode_multi');
            } else if (mode === 'span') {
                canvasStatusText.textContent = i18n.t('status_image_mode_span');
            }
        }
    }

    function recalculateAllGroupsMapping() {
        const groups = new Map();
        gridManager.getAllCells().forEach(cell => {
            if (cell.enabled && cell.imageId && cell.groupId) {
                if (!groups.has(cell.groupId)) {
                    groups.set(cell.groupId, []);
                }
                groups.get(cell.groupId).push(cell);
            }
        });
        groups.forEach((groupCells, groupId) => {
            const firstCell = groupCells[0];
            imageProcessor.recalculateGroupImageMapping(
                gridManager,
                groupCells,
                firstCell.imageId,
                firstCell.groupZoom || 1.0,
                firstCell.groupShiftX || 0,
                firstCell.groupShiftY || 0
            );
        });
    }

    function updateZoomSliderVisibility() {
        const mode = getActiveImageMode();
        if (mode === 'single' && imageProcessor.activeImageId) {
            singleImageZoomGroup?.classList.remove('hidden');
            const activeImg = imageProcessor.getImage(imageProcessor.activeImageId);
            if (activeImg && inputSingleImageZoom) {
                const zoomVal = Math.round((activeImg.zoom || 1.0) * 100);
                inputSingleImageZoom.value = zoomVal;
                if (valSingleImageZoom) {
                    valSingleImageZoom.value = zoomVal;
                }
            }
        } else {
            singleImageZoomGroup?.classList.add('hidden');
        }
    }

    radioImageModes.forEach(radio => {
        radio.addEventListener('change', () => {
            const mode = getActiveImageMode();
            if (mode === 'single') {
                singleImageWrapper.classList.remove('hidden');
                imageProcessor.recalculateSingleImageMapping(gridManager);
            } else {
                singleImageWrapper.classList.add('hidden');
                gridManager.clearImageAssignments();
            }
            updateZoomSliderVisibility();
            updateStatusText();
            planner.scheduleRender();
            preview.scheduleRender();
            saveProjectState();
        });
    });

    // Wybór głównej grafiki dla całej ściany
    selectMainImage.addEventListener('change', () => {
        imageProcessor.activeImageId = selectMainImage.value || null;
        imageProcessor.recalculateSingleImageMapping(gridManager);
        updateZoomSliderVisibility();
        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    });

    // Zmiana skali powiększenia obrazu (funkcja synchronizująca suwak z polem liczbowym)
    const handleSingleImageZoomChange = (val) => {
        if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
        return trackProjectOperation(async () => {
            if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
            let intVal = parseInt(val);
            if (isNaN(intVal)) intVal = 100;
            if (intVal < 100) intVal = 100;
            if (intVal > 500) intVal = 500;

            if (inputSingleImageZoom && parseInt(inputSingleImageZoom.value) !== intVal) {
                inputSingleImageZoom.value = intVal;
            }
            if (valSingleImageZoom && parseInt(valSingleImageZoom.value) !== intVal) {
                valSingleImageZoom.value = intVal;
            }
        
            // Synchronizacja w dół do obiektu obrazka i suwaka w bibliotece
            if (imageProcessor.activeImageId) {
                const activeImg = imageProcessor.getImage(imageProcessor.activeImageId);
                if (activeImg) {
                    const previousZoom = activeImg.zoom ?? 1;
                    activeImg.zoom = intVal / 100;
                    try {
                        await DBStore.updateZoom(activeImg.id, activeImg.zoom);
                    } catch (error) {
                        activeImg.zoom = previousZoom;
                        if (inputSingleImageZoom) inputSingleImageZoom.value = Math.round(previousZoom * 100);
                        if (valSingleImageZoom) valSingleImageZoom.value = Math.round(previousZoom * 100);
                        console.error('Nie udało się zapisać powiększenia obrazu.', error);
                        return;
                    }
                
                    // Znajdź suwak i input w UI i zaktualizuj
                    const itemElement = imageList.querySelector(`.image-item[data-id="${activeImg.id}"]`);
                    if (itemElement) {
                        const itemSlider = itemElement.querySelector('.image-zoom-slider');
                        if (itemSlider) itemSlider.value = intVal;
                        const itemNumInput = itemElement.querySelector('.zoom-number-input');
                        if (itemNumInput) itemNumInput.value = intVal;
                    }
                }
            }
            handleGridConfigChange();
        });
    };

    if (inputSingleImageZoom) {
        inputSingleImageZoom.addEventListener('input', () => {
            handleSingleImageZoomChange(inputSingleImageZoom.value);
        });
    }
    if (valSingleImageZoom) {
        valSingleImageZoom.addEventListener('input', () => {
            handleSingleImageZoomChange(valSingleImageZoom.value);
        });
    }

    // Podgląd AMS (Kwantyzacja kolorów)
    chkPreviewAms.addEventListener('change', () => {
        if (chkPreviewAms.checked) {
            selectAmsColors.classList.remove('hidden');
        } else {
            selectAmsColors.classList.add('hidden');
        }
        preview.options.amsPreview = chkPreviewAms.checked;
        preview.scheduleRender();
    });

    selectAmsColors.addEventListener('change', () => {
        preview.options.amsColors = parseInt(selectAmsColors.value) || 4;
        preview.scheduleRender();
    });

    // Obsługa drag & drop plików
    dropzone.addEventListener('click', () => {
        if (canEditProject()) fileInput.click();
    });
    
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (canEditProject()) dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (!canEditProject()) return;
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            await handleImageFiles(files);
        }
    });

    fileInput.addEventListener('change', async () => {
        if (fileInput.files.length > 0) {
            await handleImageFiles(fileInput.files);
        }
    });

    // Wczytanie plików
    async function handleImageFiles(files) {
        if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
        return trackProjectOperation(async () => {
            if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
            for (const file of files) {
                if (projectImportInProgress || projectResetInProgress) break;
                if (!file.type.startsWith('image/')) continue;
                let imgObj = null;
                try {
                    if (imageProcessor.getAllImages().length >= PROJECT_LIMITS.maxImages) {
                        throw new Error('Osiągnięto limit liczby obrazów w projekcie.');
                    }
                    imgObj = await imageProcessor.addImage(file);
                    if (projectImportInProgress || projectResetInProgress) {
                        imageProcessor.removeImage(imgObj.id);
                        continue;
                    }
                    const pixelCount = imageProcessor.getAllImages().reduce((sum, image) => sum + image.width * image.height, 0);
                    if (pixelCount > PROJECT_LIMITS.maxTotalImagePixels) throw new Error('Łączna rozdzielczość obrazów w projekcie jest zbyt duża.');
                    // Zapisz fizyczny blob pliku do trwałego IndexedDB
                    await DBStore.save(imgObj.id, imgObj.name, file, imgObj.width, imgObj.height);
                    addDraggableImageToUI(imgObj);
                } catch (err) {
                    if (imgObj) imageProcessor.removeImage(imgObj.id);
                    console.error("Nie udało się załadować obrazu:", err);
                }
            }
            updateMainImageSelector();
        
            if (getActiveImageMode() === 'single' && imageProcessor.activeImageId) {
                imageProcessor.recalculateSingleImageMapping(gridManager);
            }
        
            planner.scheduleRender();
            preview.scheduleRender();
            saveProjectState();
            });
    }

    function addDraggableImageToUI(imageObj) {
        const emptyText = imageList.querySelector('.empty-list-text');
        if (emptyText) emptyText.remove();

        const item = document.createElement('div');
        item.className = 'image-item';
        item.draggable = canEditProject();
        item.dataset.id = imageObj.id;

        // Container na podgląd obrazu oraz przycisk usuwania
        const previewContainer = document.createElement('div');
        previewContainer.className = 'image-preview-container';

        const img = document.createElement('img');
        img.src = imageObj.src;
        previewContainer.appendChild(img);

        // Przycisk usuwania
        const btnRemove = document.createElement('button');
        btnRemove.className = 'btn-remove-image';
        btnRemove.innerHTML = `
            <svg viewBox="0 0 24 24" class="icon-inline">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
            </svg>
        `;
        btnRemove.addEventListener('click', (e) => {
            e.stopPropagation();
            if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
            return trackProjectOperation(async () => {
                if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
                // Najpierw utrwal usunięcie; przy błędzie zachowaj obraz w bieżącym projekcie.
                try {
                    await DBStore.delete(imageObj.id);
                } catch (error) {
                    console.error('Nie udało się usunąć obrazu z lokalnej bazy.', error);
                    return;
                }
                imageProcessor.removeImage(imageObj.id);
                item.remove();
            
                if (imageProcessor.getAllImages().length === 0) {
                    imageList.innerHTML = `<p class="empty-list-text">${i18n.t('no_images_loaded')}</p>`;
                }
            
                updateMainImageSelector();
            
                if (getActiveImageMode() === 'single') {
                    imageProcessor.recalculateSingleImageMapping(gridManager);
                } else {
                    gridManager.getAllCells().forEach(cell => {
                        if (cell.imageId === imageObj.id) {
                            cell.imageId = null;
                            cell.cropRegion = null;
                        }
                    });
                }
            
                planner.scheduleRender();
                preview.scheduleRender();
                saveProjectState();
            });
        });
        previewContainer.appendChild(btnRemove);
        item.appendChild(previewContainer);

        // Szczegóły obrazu (nazwa, rozdzielczość)
        const details = document.createElement('div');
        details.className = 'image-details';
        
        const name = document.createElement('span');
        name.className = 'image-name';
        name.textContent = imageObj.name;
        details.appendChild(name);

        const res = document.createElement('span');
        res.className = 'image-resolution';
        
        const updateResolutionText = () => {
            const displayW = imageObj.rotatedCanvas ? imageObj.rotatedCanvas.width : imageObj.width;
            const displayH = imageObj.rotatedCanvas ? imageObj.rotatedCanvas.height : imageObj.height;
            res.textContent = `${displayW}x${displayH} px`;
        };
        updateResolutionText();
        details.appendChild(res);
        item.appendChild(details);

        // Kontener suwaków rotacji i zoomu
        const control = document.createElement('div');
        control.className = 'image-item-control';

        // 1. Grupa rotacji
        const rotRow = document.createElement('div');
        rotRow.className = 'image-item-control-row-container';

        const rotHeader = document.createElement('div');
        rotHeader.className = 'image-item-control-header';

        const rotLabel = document.createElement('span');
        rotLabel.className = 'control-label';
        rotLabel.textContent = i18n.t('image_rotation');

        const rotInputContainer = document.createElement('div');
        rotInputContainer.className = 'input-sync-container';

        const rotNumberInput = document.createElement('input');
        rotNumberInput.type = 'number';
        rotNumberInput.className = 'control-number-input rotation-number-input';
        rotNumberInput.min = '0';
        rotNumberInput.max = '360';
        rotNumberInput.value = imageObj.rotation || 0;

        const rotSuffix = document.createElement('span');
        rotSuffix.className = 'unit-suffix';
        rotSuffix.textContent = '°';

        rotInputContainer.appendChild(rotNumberInput);
        rotInputContainer.appendChild(rotSuffix);
        rotHeader.appendChild(rotLabel);
        rotHeader.appendChild(rotInputContainer);
        rotRow.appendChild(rotHeader);

        const rotSlider = document.createElement('input');
        rotSlider.type = 'range';
        rotSlider.className = 'form-range image-rotation-slider';
        rotSlider.min = '0';
        rotSlider.max = '360';
        rotSlider.step = '1';
        rotSlider.value = imageObj.rotation || 0;
        rotRow.appendChild(rotSlider);
        control.appendChild(rotRow);

        const syncRotation = (val) => {
            if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
            return trackProjectOperation(async () => {
                if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
                let angle = parseInt(val);
                if (isNaN(angle)) angle = 0;
                if (angle < 0) angle = 0;
                if (angle > 360) angle = 360;

                if (parseInt(rotSlider.value) !== angle) rotSlider.value = angle;
                if (parseInt(rotNumberInput.value) !== angle) rotNumberInput.value = angle;

                const previousRotation = imageObj.rotation ?? 0;
                try {
                    imageProcessor.rotateImage(imageObj.id, angle);
                    await DBStore.updateRotation(imageObj.id, angle);
                } catch (error) {
                    imageProcessor.rotateImage(imageObj.id, previousRotation);
                    rotSlider.value = previousRotation;
                    rotNumberInput.value = previousRotation;
                    console.error('Nie udało się zapisać obrotu obrazu.', error);
                    return;
                }
                updateResolutionText();

                const mode = getActiveImageMode();
                if (mode === 'single') {
                    if (imageProcessor.activeImageId === imageObj.id) {
                        imageProcessor.recalculateSingleImageMapping(gridManager);
                    }
                } else if (mode === 'multi') {
                    gridManager.getAllCells().forEach(cell => {
                        if (cell.imageId === imageObj.id) {
                            imageProcessor.calculateCellCoverCrop(cell, imageObj, gridManager);
                        }
                    });
                } else if (mode === 'span') {
                    const groups = new Map();
                    gridManager.getAllCells().forEach(cell => {
                        if (cell.enabled && cell.imageId === imageObj.id && cell.groupId) {
                            if (!groups.has(cell.groupId)) {
                                groups.set(cell.groupId, []);
                            }
                            groups.get(cell.groupId).push(cell);
                        }
                    });
                    groups.forEach((groupCells, groupId) => {
                        const firstCell = groupCells[0];
                        imageProcessor.recalculateGroupImageMapping(
                            gridManager,
                            groupCells,
                            imageObj.id,
                            firstCell.groupZoom || 1.0,
                            firstCell.groupShiftX || 0,
                            firstCell.groupShiftY || 0
                        );
                    });
                }

                planner.scheduleRender();
                preview.scheduleRender();
                saveProjectState();
            });
        };

        rotSlider.addEventListener('input', () => syncRotation(rotSlider.value));
        rotNumberInput.addEventListener('input', () => syncRotation(rotNumberInput.value));

        // 2. Grupa zoomu
        const zoomRow = document.createElement('div');
        zoomRow.className = 'image-item-control-row-container';

        const zoomHeader = document.createElement('div');
        zoomHeader.className = 'image-item-control-header';

        const zoomLabel = document.createElement('span');
        zoomLabel.className = 'control-label';
        zoomLabel.textContent = i18n.t('image_zoom');

        const zoomInputContainer = document.createElement('div');
        zoomInputContainer.className = 'input-sync-container';

        const zoomNumberInput = document.createElement('input');
        zoomNumberInput.type = 'number';
        zoomNumberInput.className = 'control-number-input zoom-number-input';
        zoomNumberInput.min = '100';
        zoomNumberInput.max = '500';
        zoomNumberInput.value = Math.round((imageObj.zoom || 1.0) * 100);

        const zoomSuffix = document.createElement('span');
        zoomSuffix.className = 'unit-suffix';
        zoomSuffix.textContent = '%';

        zoomInputContainer.appendChild(zoomNumberInput);
        zoomInputContainer.appendChild(zoomSuffix);
        zoomHeader.appendChild(zoomLabel);
        zoomHeader.appendChild(zoomInputContainer);
        zoomRow.appendChild(zoomHeader);

        const zoomSlider = document.createElement('input');
        zoomSlider.type = 'range';
        zoomSlider.className = 'form-range image-zoom-slider';
        zoomSlider.min = '100';
        zoomSlider.max = '500';
        zoomSlider.step = '1';
        zoomSlider.value = Math.round((imageObj.zoom || 1.0) * 100);
        zoomRow.appendChild(zoomSlider);
        control.appendChild(zoomRow);

        const syncZoom = (val) => {
            if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
            return trackProjectOperation(async () => {
                if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
                let intVal = parseInt(val);
                if (isNaN(intVal)) intVal = 100;
                if (intVal < 100) intVal = 100;
                if (intVal > 500) intVal = 500;

                if (parseInt(zoomSlider.value) !== intVal) zoomSlider.value = intVal;
                if (parseInt(zoomNumberInput.value) !== intVal) zoomNumberInput.value = intVal;

                const previousZoom = imageObj.zoom ?? 1;
                imageObj.zoom = intVal / 100;
                try {
                    await DBStore.updateZoom(imageObj.id, imageObj.zoom);
                } catch (error) {
                    imageObj.zoom = previousZoom;
                    zoomSlider.value = Math.round(previousZoom * 100);
                    zoomNumberInput.value = Math.round(previousZoom * 100);
                    console.error('Nie udało się zapisać powiększenia obrazu.', error);
                    return;
                }

                // Synchronizacja z globalnym suwakiem w panelu bocznym
                if (getActiveImageMode() === 'single' && imageProcessor.activeImageId === imageObj.id) {
                    if (inputSingleImageZoom) {
                        inputSingleImageZoom.value = intVal;
                    }
                    if (valSingleImageZoom) {
                        valSingleImageZoom.value = intVal;
                    }
                    imageProcessor.recalculateSingleImageMapping(gridManager);
                } else if (getActiveImageMode() === 'multi') {
                    gridManager.getAllCells().forEach(cell => {
                        if (cell.imageId === imageObj.id) {
                            imageProcessor.calculateCellCoverCrop(cell, imageObj, gridManager);
                        }
                    });
                } else if (getActiveImageMode() === 'span') {
                    const groups = new Map();
                    gridManager.getAllCells().forEach(cell => {
                        if (cell.enabled && cell.imageId === imageObj.id && cell.groupId) {
                            if (!groups.has(cell.groupId)) {
                                groups.set(cell.groupId, []);
                            }
                            groups.get(cell.groupId).push(cell);
                        }
                    });
                    groups.forEach((groupCells, groupId) => {
                        const currentShiftX = groupCells[0].groupShiftX || 0;
                        const currentShiftY = groupCells[0].groupShiftY || 0;
                        imageProcessor.recalculateGroupImageMapping(
                            gridManager,
                            groupCells,
                            imageObj.id,
                            imageObj.zoom || 1.0,
                            currentShiftX,
                            currentShiftY
                        );
                    });
                }

                planner.scheduleRender();
                preview.scheduleRender();
                saveProjectState();
            });
        };

        zoomSlider.addEventListener('input', () => syncZoom(zoomSlider.value));
        zoomNumberInput.addEventListener('input', () => syncZoom(zoomNumberInput.value));

        // Zapobiegaj Drag&Drop przy interakcji z suwakami i polami tekstowymi
        control.addEventListener('mouseenter', () => {
            item.setAttribute('draggable', 'false');
        });
        control.addEventListener('mouseleave', () => {
            item.draggable = canEditProject();
        });

        item.appendChild(control);

        item.addEventListener('dragstart', (e) => {
            if (!canEditProject()) {
                e.preventDefault();
                return;
            }
            e.dataTransfer.setData('text/plain', imageObj.id);
            item.classList.add('dragging');
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
        });

        imageList.appendChild(item);
        applyReadOnlyControls();
    }

    function updateMainImageSelector() {
        const images = imageProcessor.getAllImages();
        selectMainImage.innerHTML = `<option value="">${i18n.t('select_image_placeholder')}</option>`;
        images.forEach(img => {
            const opt = document.createElement('option');
            opt.value = img.id;
            opt.textContent = img.name;
            selectMainImage.appendChild(opt);
        });

        if (imageProcessor.activeImageId && images.some(i => i.id === imageProcessor.activeImageId)) {
            selectMainImage.value = imageProcessor.activeImageId;
        } else if (images.length > 0) {
            imageProcessor.activeImageId = images[0].id;
            selectMainImage.value = images[0].id;
        } else {
            imageProcessor.activeImageId = null;
            selectMainImage.value = '';
        }
        updateZoomSliderVisibility();
    }

    // Zakładki
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const targetTabId = btn.dataset.tab;
            tabContents.forEach(content => {
                if (content.id === targetTabId) {
                    content.classList.remove('hidden');
                } else {
                    content.classList.add('hidden');
                }
            });

            if (targetTabId === 'tab-planner') {
                planner.resize();
                planner.centerGrid();
            } 
            else if (targetTabId === 'tab-preview') {
                preview.resize();
                preview.centerGrid();
            } 
            else if (targetTabId === 'tab-instructions') {
                exporter.generateAssemblyInstructions();
            }
        });
    });

    // Przyciski zoomu
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
        const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
        if (activeTab === 'tab-planner') {
            planner.zoom = Math.min(planner.zoom * 1.15, 4.0);
            planner.scheduleRender();
        } else if (activeTab === 'tab-preview') {
            preview.zoom = Math.min(preview.zoom * 1.15, 4.0);
            preview.scheduleRender();
        }
    });

    document.getElementById('btn-zoom-out').addEventListener('click', () => {
        const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
        if (activeTab === 'tab-planner') {
            planner.zoom = Math.max(planner.zoom / 1.15, 0.1);
            planner.scheduleRender();
        } else if (activeTab === 'tab-preview') {
            preview.zoom = Math.max(preview.zoom / 1.15, 0.1);
            preview.scheduleRender();
        }
    });

    document.getElementById('btn-zoom-fit').addEventListener('click', () => {
        const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
        if (activeTab === 'tab-planner') {
            planner.centerGrid();
        } else if (activeTab === 'tab-preview') {
            preview.centerGrid();
        }
    });

    document.getElementById('btn-select-all').addEventListener('click', () => {
        gridManager.setAllCellsStatus(true);
        gridManager.checkBedSizeFit();
        checkBedVolumeAlert();
        if (getActiveImageMode() === 'single') {
            imageProcessor.recalculateSingleImageMapping(gridManager);
        }
        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    });

    document.getElementById('btn-deselect-all').addEventListener('click', () => {
        gridManager.setAllCellsStatus(false);
        checkBedVolumeAlert();
        planner.scheduleRender();
        preview.scheduleRender();
        saveProjectState();
    });

    // Opcje podglądu
    const chkPreviewGaps = document.getElementById('chk-preview-gaps');
    const chkPreviewLabels = document.getElementById('chk-preview-labels');
    const chkPreviewFrames = document.getElementById('chk-preview-frames');
    const selectPreviewBg = document.getElementById('preview-bg-select');

    function updatePreviewOptions() {
        preview.options.showGaps = chkPreviewGaps.checked;
        preview.options.showLabels = chkPreviewLabels.checked;
        preview.options.showFrames = chkPreviewFrames.checked;
        preview.options.showRuler = chkPreviewRuler ? chkPreviewRuler.checked : true;
        preview.options.showHangers = chkPreviewHangers ? chkPreviewHangers.checked : false;
        preview.options.background = selectPreviewBg.value;

        // Synchronizuj przełącznik "Pokazuj ramki" z lewym panelem "Włącz generowanie ramek"
        if (chkFrameEnable.checked !== chkPreviewFrames.checked) {
            chkFrameEnable.checked = chkPreviewFrames.checked;
            if (chkFrameEnable.checked) {
                frameSettingsSub.classList.remove('hidden');
            } else {
                frameSettingsSub.classList.add('hidden');
            }
            gridManager.updateConfig(readConfigFromUI());
            checkBedVolumeAlert();
            planner.scheduleRender();
        }

        preview.scheduleRender();
        saveProjectState();
    }

    [chkPreviewGaps, chkPreviewLabels, chkPreviewFrames, chkPreviewRuler, chkPreviewHangers, selectPreviewBg].forEach(el => {
        if (el) el.addEventListener('change', updatePreviewOptions);
    });

    // Obsługa trybów interakcji (Siatka vs Kadr / Przesuwanie zdjęć)
    if (btnModeGrid && btnModeImage) {
        btnModeGrid.addEventListener('click', () => {
            btnModeGrid.classList.add('active');
            btnModeImage.classList.remove('active');
            planner.interactionMode = 'grid';
            updateStatusText();
        });
        btnModeImage.addEventListener('click', () => {
            btnModeImage.classList.add('active');
            btnModeGrid.classList.remove('active');
            planner.interactionMode = 'image';
            updateStatusText();
        });
    }

    // Nasłuchiwanie zmian siatki z canvasa
    document.getElementById('planner-canvas').addEventListener('gridchange', () => {
        gridManager.checkBedSizeFit();
        checkBedVolumeAlert();
        preview.scheduleRender();
        saveProjectState();
    });

    function showProjectError(operation, error) {
        console.error(`Błąd ${operation} projektu:`, error);
        const message = i18n.locale === 'en'
            ? `The project could not be ${operation === 'zapisu' ? 'saved' : 'loaded'}. Check that the file is valid and try again.`
            : `Nie udało się ${operation === 'zapisu' ? 'zapisać' : 'wczytać'} projektu. Sprawdź plik i spróbuj ponownie.`;
        alert(message);
    }

    async function decodeProjectImage(blob, meta) {
        if (!(blob instanceof Blob) || blob.size === 0 || blob.size > PROJECT_LIMITS.maxImageBytes) {
            throw new Error(`Plik obrazu ${meta.name || meta.id} ma niepoprawny rozmiar.`);
        }
        const url = URL.createObjectURL(blob);
        const image = new Image();
        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Przekroczono czas dekodowania obrazu.')), 30_000);
                image.onload = () => { clearTimeout(timeout); resolve(); };
                image.onerror = () => { clearTimeout(timeout); reject(new Error(`Nie można odczytać obrazu ${meta.name || meta.id}.`)); };
                image.src = url;
            });
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            assertImageDimensions(width, height);
            if (width !== meta.width || height !== meta.height) {
                throw new Error(`Wymiary obrazu ${meta.name || meta.id} nie zgadzają się z opisem projektu.`);
            }
        } finally {
            image.onload = null;
            image.onerror = null;
            URL.revokeObjectURL(url);
        }
    }

    // Zapis projektu do pliku .hexproj (ZIP z grafikami i wersjonowanym układem).
    async function saveProjectToFile() {
        if (projectImportInProgress || projectResetInProgress) { alert(i18n.t('export_busy')); return; }
        return exporter.runExport({
            filename: 'project.hexproj', progress: 'saving_project',
            maxBytes: PROJECT_LIMITS.maxArchiveBytes,
            limitErrorKey: 'project_archive_limit',
            captureSnapshot: async signal => {
                const editingSurfaces = [...document.querySelectorAll('.app-header, .app-body')];
                const previousInert = editingSurfaces.map(element => element.inert);
                editingSurfaces.forEach(element => { element.inert = true; });
                try {
                    await waitForArchiveTask(drainProjectOperations(), signal);
                    if (historyRestorePromise) await waitForArchiveTask(historyRestorePromise, signal);
                    const snapshot = await waitForArchiveTask(DBStore.getProjectSnapshot(), signal);
                    signal.throwIfAborted();
                    const layout = JSON.parse(JSON.stringify(canEditProject()
                        ? buildProjectLayout() : snapshot.layout || buildProjectLayout()));
                    const entries = await waitForArchiveTask(createProjectArchiveEntries(snapshot.images, layout, { signal }), signal);
                    return { entries, dispose() {} };
                } finally {
                    editingSurfaces.forEach((element, index) => { element.inert = previousInert[index]; });
                }
            },
            selectEntries: snapshot => snapshot.entries,
            generate: entry => entry
        });
    }

    // Najpierw waliduje cały ZIP i dekoduje wszystkie obrazy; podmiana IDB/layoutu jest jedną transakcją.
    async function loadProjectFromFile(file) {
        if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
        projectImportInProgress = true;
        let importCommitted = false;
        try {
            if (!file || file.size > PROJECT_LIMITS.maxArchiveBytes) throw new Error('Plik projektu jest zbyt duży.');
            const zip = await JSZip.loadAsync(file);
            const projectJsonFile = zip.file('project.json');
            if (!projectJsonFile) throw new Error('Brakuje project.json.');
            const jsonSize = projectJsonFile._data?.uncompressedSize;
            if (!Number.isFinite(jsonSize) || jsonSize > 5 * 1024 * 1024) throw new Error('Opis projektu jest zbyt duży lub nieznany.');

            const projectData = JSON.parse(await projectJsonFile.async('text'));
            const imagesToImport = validateProjectArchiveMetadata(projectData, zip, file.size);
            const stagedImages = [];
            for (const { meta, entry } of imagesToImport) {
                const blob = await normalizeProjectImageBlob(await entry.async('blob'), meta.mimeType, meta.name);
                if (blob.size > PROJECT_LIMITS.maxImageBytes) throw new Error(`Obraz ${meta.name || meta.id} jest zbyt duży.`);
                await decodeProjectImage(blob, meta);
                stagedImages.push({
                    id: meta.id,
                    name: meta.name,
                    blob,
                    width: meta.width,
                    height: meta.height,
                    rotation: meta.rotation ?? 0,
                    zoom: meta.zoom ?? 1
                });
            }

            if (layoutSaveTimer !== null) {
                clearTimeout(layoutSaveTimer);
                layoutSaveTimer = null;
            }
            lastLayoutTimestamp = Math.max(Date.now(), lastLayoutTimestamp + 1);
            const committedLayout = { ...projectData.layout, savedAt: lastLayoutTimestamp };
            await DBStore.replaceProject(stagedImages, committedLayout);
            importCommitted = true;
            saveLayoutBackup(committedLayout, { committed: true });
            window.location.reload();
        } catch (err) {
            showProjectError('wczytywania', err);
        } finally {
            if (!importCommitted) projectImportInProgress = false;
            projectFileInput.value = '';
        }
    }

    // Eventy zapisu i wczytywania projektu z pliku
    document.getElementById('btn-save-project').addEventListener('click', saveProjectToFile);
    
    const projectFileInput = document.getElementById('project-file-input');
    document.getElementById('btn-load-project').addEventListener('click', () => {
        if (!canEditProject()) return;
        projectFileInput.click();
    });
    
    projectFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            loadProjectFromFile(file);
        }
    });

    // Resetowanie projektu
    document.getElementById('btn-reset-project').addEventListener('click', async () => {
        if (projectImportInProgress || projectResetInProgress || !canEditProject()) return;
        if (confirm(i18n.t('confirm_reset'))) {
            projectResetInProgress = true;
            const precedingOperations = [...activeProjectOperations];
            let resetCompleted = false;
            try {
                await trackProjectOperation(async () => {
                    const app = document.getElementById('app');
                    const previousInert = app.inert;
                    app.inert = true;
                    try {
                        await waitForProjectOperations(precedingOperations);
                        if (projectImportInProgress || !canEditProject()) return;
                        if (layoutSaveTimer !== null) {
                            clearTimeout(layoutSaveTimer);
                            layoutSaveTimer = null;
                        }
                        try {
                            await DBStore.clear();
                        } catch (error) {
                            console.error('Nie udało się wyczyścić lokalnej bazy projektu.', error);
                            alert(i18n.locale === 'en' ? 'The project could not be cleared because local storage failed.' : 'Nie udało się wyczyścić projektu z powodu błędu lokalnej bazy.');
                            return;
                        }
                        gridManager.clearImageAssignments();
                        gridManager.setAllCellsStatus(true);
            
                        // Wyczyść IndexedDB i ImageProcessor
                        imageProcessor.clearAll();
            
                        imageList.innerHTML = `<p class="empty-list-text">${i18n.t('no_images_loaded')}</p>`;
            
                        updateMainImageSelector();
            
                        // Wyzeruj przesunięcia i skalę obrazu
                        gridManager.config.singleImageOffsetX = 0;
                        gridManager.config.singleImageOffsetY = 0;
                        gridManager.config.singleImageScale = 1.0;
                        if (inputSingleImageZoom) {
                            inputSingleImageZoom.value = 100;
                        }
                        if (valSingleImageZoom) {
                            valSingleImageZoom.value = 100;
                        }


                        // Zresetuj tryb interakcji
                        if (btnModeGrid && btnModeImage) {
                            btnModeGrid.classList.add('active');
                            btnModeImage.classList.remove('active');
                            planner.interactionMode = 'grid';
                            updateStatusText();
                        }

                        // Przywróć domyślne parametry w UI
                        inputCols.value = 4;
                        inputRows.value = 3;
                        inputHexSize.value = 100;
                        selectOrientation.value = 'flat-top';
                        selectStagger.value = 'left';
                        inputGap.value = 2;
                        selectDpi.value = 300;
                        if (chkHalfHexes) chkHalfHexes.checked = false;
                        if (selectFormat) selectFormat.value = 'png';
                        if (inputQuality) inputQuality.value = 90;
                        if (valQuality) valQuality.textContent = '90%';
                        if (jpgQualityGroup) jpgQualityGroup.classList.add('hidden');
                        chkBedVerify.checked = true;
                        inputBedX.value = 256;
                        inputBedY.value = 256;
                        chkFrameEnable.checked = true;
                        selectFrameType.value = 'outline';
                        inputFrameWidth.value = 2;
                        inputFrameClearance.value = 0.2;
                        if (inputFrameHeight) inputFrameHeight.value = 10;
                        if (inputFrameSleeveBase) inputFrameSleeveBase.value = 1.2;
                        inputFrameColor.value = '#1a1a1a';
                        if (chkSyncFrameWidth) chkSyncFrameWidth.checked = true;
                        updateFrameWidthSync();
                        if (chkPreviewRuler) chkPreviewRuler.checked = true;
                        document.getElementById('frame-color').value = '#1a1a1a';
                        document.getElementById('frame-color-hex').textContent = '#1A1A1A';
            
                        // Zresetuj reliefy
                        chkReliefEnable.checked = true;
                        inputReliefHeight.value = 2.0;
                        inputReliefBaseThickness.value = 1.2;
                        chkReliefInvert.checked = false;
                        inputReliefSectors.value = 120;
                        inputReliefRings.value = 60;
                        if (inputReliefBlur) inputReliefBlur.value = 1.5;
                        if (valReliefBlur) valReliefBlur.textContent = '1.5px';
            
                        // Wywołaj handlery
                        handleBedVerifyChange();
                        handleFrameConfigChange();
                        handleReliefConfigChange();
            
                        localStorage.removeItem('hexsplitter_project_layout');

                        planner.centerGrid();
                        preview.scheduleRender();
                        historyController?.reset();
                        resetCompleted = true;
                    } finally {
                        app.inert = previousInert;
                        projectResetInProgress = false;
                    }
                });
                if (resetCompleted && canEditProject()) saveProjectState();
            } catch (error) {
                projectResetInProgress = false;
                console.error('Nie udało się bezpiecznie zresetować projektu.', error);
                alert(i18n.locale === 'en'
                    ? 'The project could not be reset while another operation was still running.'
                    : 'Nie udało się zresetować projektu, ponieważ inna operacja nie zakończyła się poprawnie.');
            }
        }
    });

    // Eksport ZIP z heksami
    document.getElementById('btn-export-hexes').addEventListener('click', async () => {
        await exporter.exportHexesZip();
    });

    // Eksport ramki jako STL
    document.getElementById('btn-export-frame-stl')?.addEventListener('click', async () => {
        await exporter.exportFrameSTL();
    });

    // Eksport heksów 3D jako STL
    btnExport3dHexesStl?.addEventListener('click', async () => {
        const reliefEnable = chkReliefEnable.checked;
        if (!reliefEnable) {
            alert(i18n.t('alert_relief_disabled'));
            return;
        }
        const options = {
            reliefHeight: readNumberInput(inputReliefHeight, 2, 0.1, 50),
            baseThickness: readNumberInput(inputReliefBaseThickness, 1.2, 0.4, 50),
            invert: chkReliefInvert.checked,
            sectors: readNumberInput(inputReliefSectors, 120, 30, 360, true),
            rings: readNumberInput(inputReliefRings, 60, 15, 180, true),
            blur: readNumberInput(inputReliefBlur, 1.5, 0, 5)
        };
        await exporter.exportHexes3DStl(options);
    });

    // Eksport uchwytu Y (STL)
    document.getElementById('btn-export-hanger').addEventListener('click', () => {
        const gridConfig = gridManager.config;
        const hangerConfig = {
            clearance: readNumberInput(inputHangerClearance, 0.3, 0, 5),
            baseThickness: readNumberInput(inputHangerBaseThickness, 1.2, 0.5, 10),
            ridgeHeight: readNumberInput(inputHangerRidgeHeight, 2, 1, 20),
            armWidth: readNumberInput(inputHangerArmWidth, 12, 5, 100),
            armLength: readNumberInput(inputHangerArmLength, 30, 10, 200)
        };
        const stlString = HangerGenerator.generateSTL(gridConfig, hangerConfig);
        const blob = new Blob([stlString], { type: 'application/sla' });
        saveAs(blob, `hexsplitter_uchwyt_y.stl`);
    });

    // Drukowanie
    document.getElementById('btn-print-instructions').addEventListener('click', () => {
        window.print();
    });

    // Dopasowanie do okna
    window.addEventListener('resize', () => {
        const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
        if (activeTab === 'tab-planner') {
            planner.resize();
        } else if (activeTab === 'tab-preview') {
            preview.resize();
        }
    });

    function getHistorySnapshot(layout = buildProjectLayout()) {
        const normalizedLayout = structuredClone(layout);
        normalizedLayout.cells = normalizedLayout.cells.map(cell => ({
            ...cell,
            imageId: cell.imageId ?? null, cropRegion: cell.cropRegion ?? null,
            groupId: cell.groupId ?? null, groupShiftX: cell.groupShiftX ?? null,
            groupShiftY: cell.groupShiftY ?? null, groupZoom: cell.groupZoom ?? null
        }));
        return {
            layout: normalizedLayout,
            images: imageProcessor.getAllImages().map(image => ({
                id: image.id, rotation: image.rotation ?? 0, zoom: image.zoom ?? 1
            }))
        };
    }

    // Update view controls without firing edit handlers or writing an intermediate layout.
    function syncProjectUI() {
        updateFrameWidthSync();
        document.querySelector('.id-bed-settings-container')?.classList.toggle('hidden', !chkBedVerify.checked);
        frameSettingsSub.classList.toggle('hidden', !chkFrameEnable.checked);
        document.getElementById('frame-sleeve-base-container')?.classList.toggle('hidden', !chkFrameEnable.checked || selectFrameType.value !== 'sleeve');
        reliefSettingsSub.classList.toggle('hidden', !chkReliefEnable.checked);
        jpgQualityGroup.classList.toggle('hidden', selectFormat.value !== 'jpg');
        singleImageWrapper.classList.toggle('hidden', getActiveImageMode() !== 'single');
        txtFrameColorHex.textContent = inputFrameColor.value.toUpperCase();
        valQuality.textContent = `${inputQuality.value}%`;
        if (valReliefBlur) valReliefBlur.textContent = `${inputReliefBlur.value}px`;
        Object.assign(preview.options, {
            showGaps: chkPreviewGaps.checked, showLabels: chkPreviewLabels.checked,
            showFrames: chkPreviewFrames.checked, showRuler: chkPreviewRuler.checked,
            showHangers: chkPreviewHangers.checked, background: selectPreviewBg.value
        });
        updateMainImageSelector();
        updateStaggerDropdownLabels();
        updateHexDimensionLabels();
        updateStatusText();
    }

    function applyProjectLayout(layout) {
        applyLayoutFields(layout);
        gridManager.config.singleImageOffsetX = layout.grid?.singleImageOffsetX ?? 0;
        gridManager.config.singleImageOffsetY = layout.grid?.singleImageOffsetY ?? 0;
        if (inputSingleImageZoom) inputSingleImageZoom.value = Math.round((layout.grid?.singleImageScale ?? 1) * 100);
        if (valSingleImageZoom) valSingleImageZoom.value = inputSingleImageZoom.value;
        if (imageProcessor.getImage(layout.activeImageId)) imageProcessor.activeImageId = layout.activeImageId;
        gridManager.updateConfig(readConfigFromUI());
        for (const savedCell of layout.cells || []) {
            const cell = gridManager.getCell(savedCell.q, savedCell.r);
            if (!cell) continue;
            const hasImage = savedCell.imageId && imageProcessor.getImage(savedCell.imageId);
            Object.assign(cell, {
                enabled: savedCell.enabled ?? true, imageId: hasImage ? savedCell.imageId : null,
                cropRegion: hasImage ? structuredClone(savedCell.cropRegion ?? null) : null,
                groupId: hasImage ? savedCell.groupId : null,
                groupShiftX: hasImage ? savedCell.groupShiftX : null,
                groupShiftY: hasImage ? savedCell.groupShiftY : null,
                groupZoom: hasImage ? savedCell.groupZoom : null
            });
        }
        if (getActiveImageMode() === 'single' && !(layout.cells || []).length) imageProcessor.recalculateSingleImageMapping(gridManager);
        gridManager.checkBedSizeFit();
        syncProjectUI();
        checkBedVolumeAlert();
        planner.isDraggingImage = false;
        planner.draggedCell = null;
        planner.scheduleRender();
        preview.scheduleRender();
    }

    function syncImageControls() {
        for (const image of imageProcessor.getAllImages()) {
            const item = imageList.querySelector(`.image-item[data-id="${image.id}"]`);
            if (!item) continue;
            item.querySelectorAll('.rotation-number-input, .image-rotation-slider').forEach(input => { input.value = image.rotation ?? 0; });
            item.querySelectorAll('.zoom-number-input, .image-zoom-slider').forEach(input => { input.value = Math.round((image.zoom ?? 1) * 100); });
            const source = imageProcessor.getRotatedCanvasOrImage(image);
            const label = item.querySelector('.image-resolution');
            if (label) label.textContent = `${source.width}x${source.height} px`;
        }
    }

    async function restoreHistorySnapshot(snapshot) {
        if (!canEditProject() || projectImportInProgress) throw new Error('Project is not editable.');
        if (layoutSaveTimer !== null) { clearTimeout(layoutSaveTimer); layoutSaveTimer = null; }
        const app = document.getElementById('app');
        const previousInert = app.inert;
        const focusedElement = document.activeElement;
        const layout = structuredClone(snapshot.layout);
        lastLayoutTimestamp = Math.max(Date.now(), lastLayoutTimestamp + 1);
        layout.savedAt = lastLayoutTimestamp;
        const task = (async () => {
            app.inert = true;
            app.setAttribute('aria-busy', 'true');
            try {
                await DBStore.saveHistoryState(layout, snapshot.images);
                for (const transform of snapshot.images) {
                    const image = imageProcessor.getImage(transform.id);
                    if (!image) continue;
                    if ((image.rotation ?? 0) !== transform.rotation) imageProcessor.rotateImage(image.id, transform.rotation);
                    image.zoom = transform.zoom;
                }
                applyProjectLayout(layout);
                syncImageControls();
                saveLayoutBackup(layout, { committed: true });
            } finally {
                app.inert = previousInert;
                app.removeAttribute('aria-busy');
                if (focusedElement?.isConnected && !focusedElement.disabled) focusedElement.focus({ preventScroll: true });
            }
        })();
        historyRestorePromise = task;
        try { await task; }
        finally { if (historyRestorePromise === task) historyRestorePromise = null; }
    }

    // --- PRZYWRACANIE STANU PROJEKTU PRZY URUCHOMIENIU ---
    async function loadSavedProjectState() {
        try {
            // 1. Wczytaj obrazy z IndexedDB
            let savedImages = [];
            try {
                savedImages = await DBStore.getAll();
            } catch (storageError) {
                console.error('Nie udało się odczytać obrazów z lokalnej bazy projektu.', storageError);
            }
            if (savedImages && savedImages.length > 0) {
                const emptyText = imageList.querySelector('.empty-list-text');
                if (emptyText) emptyText.remove();
                let restoredImagePixels = 0;
                let skippedImageCount = 0;

                for (const saved of savedImages) {
                    let url = null;
                    const img = new Image();
                    try {
                        if (imageProcessor.images.size >= PROJECT_LIMITS.maxImages) throw new Error('Osiągnięto limit liczby obrazów.');
                        if (!(saved.blob instanceof Blob)) throw new Error('Brakuje danych obrazu.');
                        url = URL.createObjectURL(saved.blob);
                        await new Promise((resolve, reject) => {
                            const timeout = setTimeout(() => reject(new Error('Przekroczono czas wczytywania obrazu.')), 30_000);
                            img.onload = () => { clearTimeout(timeout); resolve(); };
                            img.onerror = () => { clearTimeout(timeout); reject(new Error(`Nie można odczytać obrazu ${saved.name || saved.id}.`)); };
                            img.src = url;
                        });
                        const width = img.naturalWidth || img.width;
                        const height = img.naturalHeight || img.height;
                        assertImageDimensions(width, height);
                        if (saved.width !== width || saved.height !== height) throw new Error('Wymiary nie zgadzają się z metadanymi obrazu.');
                        if (restoredImagePixels + width * height > PROJECT_LIMITS.maxTotalImagePixels) throw new Error('Łączna rozdzielczość obrazów jest zbyt duża.');
                        const rotation = parseBoundedNumber(saved.rotation, 0, 0, 360);
                        const zoom = parseBoundedNumber(saved.zoom, 1, 1, 5);
                        const imageObj = {
                            id: saved.id,
                            name: typeof saved.name === 'string' ? saved.name : 'image',
                            imgElement: img,
                            width,
                            height,
                            src: url,
                            rotation,
                            zoom
                        };
                        imageProcessor.images.set(saved.id, imageObj);
                        if (rotation !== 0) imageProcessor.rotateImage(saved.id, rotation);
                        addDraggableImageToUI(imageObj);
                        restoredImagePixels += width * height;
                    } catch (error) {
                        if (url) URL.revokeObjectURL(url);
                        imageProcessor.removeImage(saved.id);
                        console.warn(`Pominięto uszkodzony obraz projektu (${saved.id}).`, error);
                        skippedImageCount++;
                    } finally {
                        img.onload = null;
                        img.onerror = null;
                    }
                }
                if (skippedImageCount > 0) {
                    const warning = i18n.locale === 'en'
                        ? `${skippedImageCount} saved image${skippedImageCount === 1 ? ' could' : 's could'} not be restored. The original data remain in local storage.`
                        : `Nie udało się przywrócić ${skippedImageCount} zapisanych obrazów. Oryginalne dane pozostały w lokalnej bazie.`;
                    alert(warning);
                }
                if (imageProcessor.getAllImages().length === 0) {
                    imageList.innerHTML = `<p class="empty-list-text">${i18n.t('no_images_loaded')}</p>`;
                }
                updateMainImageSelector();
            }

            // 2. Najpierw czytaj układ z tej samej bazy co obrazy; localStorage obsługuje starsze instalacje.
            let layout = null;
            const databaseLayout = await DBStore.getLayout().catch(error => {
                console.error('Nie udało się odczytać układu z lokalnej bazy projektu.', error);
                return null;
            });
            let localLayout = null;
            try {
                const layoutStr = localStorage.getItem('hexsplitter_project_layout');
                localLayout = layoutStr ? JSON.parse(layoutStr) : null;
            } catch (error) {
                console.warn('Pominięto niepoprawny układ z localStorage.', error);
                if (projectSession?.canWrite) {
                    try { localStorage.removeItem('hexsplitter_project_layout'); } catch {}
                }
            }
            persistedLayoutTimestamp = parseBoundedNumber(databaseLayout?.savedAt, 0, 0, Number.MAX_SAFE_INTEGER);
            if (localLayout && databaseLayout) {
                const base = localLayout.backupBaseSavedAt;
                const matchesRevision = typeof base === 'number' &&
                    (base === persistedLayoutTimestamp || localLayout.savedAt === persistedLayoutTimestamp);
                // A pending backup is safe only against the same durable revision.
                // Newer work committed by another tab always wins over an old tab's backup.
                if (!matchesRevision) localLayout = null;
            }
            const candidates = [
                { value: databaseLayout, source: 'IndexedDB' },
                { value: localLayout, source: 'localStorage' }
            ].filter(candidate => candidate.value);
            candidates.sort((a, b) => parseBoundedNumber(b.value.savedAt, 0, 0, Number.MAX_SAFE_INTEGER) -
                parseBoundedNumber(a.value.savedAt, 0, 0, Number.MAX_SAFE_INTEGER));
            for (const candidate of candidates) {
                try {
                    layout = validateProjectLayout(candidate.value);
                    break;
                } catch (error) {
                    console.warn(`Pominięto niepoprawny układ z ${candidate.source}.`, error);
                    if (candidate.source === 'IndexedDB') await DBStore.clearLayout().catch(() => {});
                    if (candidate.source === 'localStorage' && projectSession?.canWrite) {
                        try { localStorage.removeItem('hexsplitter_project_layout'); } catch {}
                    }
                }
            }
            if (layout) lastLayoutTimestamp = parseBoundedNumber(layout.savedAt, 0, 0, Number.MAX_SAFE_INTEGER);

            if (layout) applyProjectLayout(layout);
            else {
                gridManager.updateConfig(readConfigFromUI());
                syncProjectUI();
            }

            updateStaggerDropdownLabels();
            updateZoomSliderVisibility();
            updateHexDimensionLabels();
            gridManager.checkBedSizeFit();
            checkBedVolumeAlert();

            // Dopasuj płótno planera i narysuj
            planner.resize();
            planner.centerGrid();
            
            preview.resize();
            preview.centerGrid();
        } catch (err) {
            console.error("Błąd przywracania stanu projektu:", err);
        }
    }

    const sessionDisabledState = new WeakMap();
    const viewOnlyActions = new Set([
        'btn-save-project', 'btn-zoom-in', 'btn-zoom-out', 'btn-zoom-fit',
        'btn-export-hanger', 'btn-export-hexes', 'btn-export-frame-stl',
        'btn-export-3d-hexes-stl', 'btn-print-instructions', 'btn-cancel-export'
    ]);
    function isViewOnlyControl(element) {
        return element.id === 'select-lang' || element.id === 'btn-take-over-project' ||
            element.classList.contains('tab-btn') || viewOnlyActions.has(element.id) ||
            element.id.startsWith('btn-export-');
    }

    function applyReadOnlyControls() {
        const readOnly = !canEditProject();
        document.querySelectorAll('button, input, select, textarea').forEach(element => {
            if (isViewOnlyControl(element)) return;
            if (readOnly) {
                if (!sessionDisabledState.has(element)) sessionDisabledState.set(element, element.disabled);
                element.disabled = true;
            } else if (sessionDisabledState.has(element)) {
                element.disabled = sessionDisabledState.get(element);
                sessionDisabledState.delete(element);
            }
        });

        const plannerCanvas = document.getElementById('planner-canvas');
        if (plannerCanvas) {
            if (readOnly) {
                if (plannerCanvas.dataset.sessionPointerEvents === undefined) {
                    plannerCanvas.dataset.sessionPointerEvents = plannerCanvas.style.pointerEvents;
                    plannerCanvas.dataset.sessionTabIndex = String(plannerCanvas.tabIndex);
                }
                plannerCanvas.style.pointerEvents = 'none';
                plannerCanvas.tabIndex = -1;
            } else if (plannerCanvas.dataset.sessionPointerEvents !== undefined) {
                plannerCanvas.style.pointerEvents = plannerCanvas.dataset.sessionPointerEvents;
                plannerCanvas.tabIndex = Number(plannerCanvas.dataset.sessionTabIndex);
                delete plannerCanvas.dataset.sessionPointerEvents;
                delete plannerCanvas.dataset.sessionTabIndex;
            }
        }
        const dropzoneElement = document.getElementById('dropzone');
        if (dropzoneElement) dropzoneElement.setAttribute('aria-disabled', String(readOnly));
        imageList.querySelectorAll('.image-item').forEach(item => { item.draggable = !readOnly; });
    }

    function renderProjectSessionStatus(status) {
        if (!['owner', 'releasing', 'suspending'].includes(status.state) && layoutSaveTimer !== null) {
            clearTimeout(layoutSaveTimer);
            layoutSaveTimer = null;
        }
        const banner = document.getElementById('project-session-banner');
        const message = document.getElementById('project-session-message');
        const takeOverButton = document.getElementById('btn-take-over-project');
        const ownsEditing = projectReady && status.state === 'owner' && status.isOwner;
        if (banner) {
            banner.hidden = ownsEditing;
            banner.classList.toggle('hidden', ownsEditing);
        }
        if (message) {
            const waiting = !projectReady || ['starting', 'taking-over', 'suspending', 'suspended', 'releasing'].includes(status.state);
            message.textContent = i18n.t(waiting ? 'project_session_loading' : 'project_read_only');
        }
        if (takeOverButton) {
            takeOverButton.textContent = i18n.t('take_over_project');
            takeOverButton.disabled = !projectReady || ['starting', 'taking-over', 'unavailable', 'suspending', 'suspended', 'releasing'].includes(status.state);
        }
        applyReadOnlyControls();
    }

    projectSession = new ProjectSession({
        store: DBStore,
        onStatusChange: renderProjectSessionStatus,
        beforeRelease: drainAndFlushProjectState,
        beforeSuspend: drainAndFlushProjectState
    });
    DBStore.setWriteGuard(projectSession);
    window.projectSession = projectSession;
    renderProjectSessionStatus({ state: projectSession.state, isOwner: false, canWrite: false });

    const takeOverButton = document.getElementById('btn-take-over-project');
    takeOverButton?.addEventListener('click', async () => {
        if (canEditProject() || takeOverButton.disabled) return;
        const acquired = await projectSession.takeOver();
        if (acquired) window.location.reload();
    });

    document.getElementById('planner-canvas')?.addEventListener('keydown', event => {
        if (!canEditProject()) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);

    historyController = new HistoryController({
        capture: getHistorySnapshot,
        apply: restoreHistorySnapshot,
        canEdit: () => canEditProject() && !projectImportInProgress,
        shouldGroupDrag: () => planner.interactionMode === 'image',
        onError: error => { console.error('Undo/redo failed:', error); alert(i18n.t('history_restore_failed')); }
    });
    await projectSession.start();
    applyReadOnlyControls();

    window.addEventListener('pagehide', () => {
        void projectSession.close().finally(() => DBStore.close());
    });

    // Nasłuchiwanie zmian języka
    document.addEventListener('languagechange', () => {
        if (imageProcessor.getAllImages().length === 0) {
            imageList.innerHTML = `<p class="empty-list-text">${i18n.t('no_images_loaded')}</p>`;
        }
        updateMainImageSelector();
        updateStatusText();
        updateHexDimensionLabels();
        if (projectSession) renderProjectSessionStatus({
            state: projectSession.state,
            isOwner: projectSession.isOwner,
            canWrite: projectSession.canWrite
        });
        const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
        if (activeTab === 'tab-instructions') {
            exporter.generateAssemblyInstructions();
        }
    });

    // Rozpocznij przywracanie stanu po wczytaniu DOM
    projectLoadPromise = loadSavedProjectState();
    await projectLoadPromise;
    projectReady = true;
    renderProjectSessionStatus({ state: projectSession.state, isOwner: projectSession.isOwner, canWrite: projectSession.canWrite });
    syncProjectUI();
    historyController.reset();
    if (canEditProject()) saveProjectState();
});
