import GridManager from './grid-manager.js?v=1.0.3';
import ImageProcessor from './image-processor.js?v=1.0.3';
import WallPlanner from './wall-planner.js?v=1.0.3';
import PreviewRenderer from './preview-renderer.js?v=1.0.3';
import ExportManager from './export-manager.js?v=1.0.3';
import HangerGenerator from './hanger-generator.js?v=1.0.3';
import { i18n } from './i18n.js?v=1.0.3';

// Silnik magazynu IndexedDB do trwałego zapisywania oryginalnych plików graficznych
class DBStore {
    static DB_NAME = 'HexSplitterImagesDB';
    static DB_VERSION = 1;
    static STORE_NAME = 'images';

    static open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    static async save(id, name, blob, width, height) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            store.put({ id, name, blob, width, height, rotation: 0, zoom: 1 });
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    static async updateRotation(id, rotation) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.get(id);
            req.onsuccess = () => {
                const record = req.result;
                if (record) {
                    record.rotation = rotation;
                    store.put(record);
                }
                resolve();
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    static async updateZoom(id, zoom) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.get(id);
            req.onsuccess = () => {
                const record = req.result;
                if (record) {
                    record.zoom = zoom;
                    store.put(record);
                }
                resolve();
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    static async delete(id) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            store.delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    static async getAll() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    static async clear() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            store.clear();
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // Inicjalizacja modułów
    const gridManager = new GridManager();
    const imageProcessor = new ImageProcessor();
    const planner = new WallPlanner('planner-canvas', gridManager, imageProcessor);
    const preview = new PreviewRenderer('preview-canvas', gridManager, imageProcessor);
    const exporter = new ExportManager(gridManager, imageProcessor);

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
    function readConfigFromUI() {
        return {
            columns: parseInt(inputCols.value) || 4,
            rows: parseInt(inputRows.value) || 3,
            hexSize: parseFloat(inputHexSize.value) || 100,
            orientation: selectOrientation.value || 'flat-top',
            stagger: selectStagger.value || 'left',
            gap: parseFloat(inputGap.value) || 2,
            dpi: selectDpi.value === 'original' ? 'original' : (parseInt(selectDpi.value) || 300),
            exportFormat: selectFormat.value || 'png',
            exportQuality: (parseFloat(inputQuality.value) || 90) / 100,
            bedX: parseFloat(inputBedX.value) || 256,
            bedY: parseFloat(inputBedY.value) || 256,
            bedVerify: chkBedVerify.checked,
            frameEnable: chkFrameEnable.checked,
            frameWidth: parseFloat(inputFrameWidth.value) || 2,
            frameClearance: parseFloat(inputFrameClearance.value) || 0.2,
            frameHeight: parseFloat(inputFrameHeight?.value) || 10,
            frameSleeveBase: parseFloat(inputFrameSleeveBase?.value) || 1.2,
            singleImageOffsetX: gridManager.config.singleImageOffsetX || 0,
            singleImageOffsetY: gridManager.config.singleImageOffsetY || 0,
            singleImageScale: parseFloat(inputSingleImageZoom?.value || 100) / 100 || 1.0,
            halfHexes: chkHalfHexes?.checked || false
        };
    }

    function updateFrameWidthSync() {
        if (chkSyncFrameWidth) {
            if (chkSyncFrameWidth.checked) {
                inputFrameWidth.value = inputGap.value;
                inputFrameWidth.disabled = true;
            } else {
                inputFrameWidth.disabled = false;
            }
        }
    }



    function updateHexDimensionLabels() {
        const size = parseFloat(inputHexSize.value) || 100;
        const orientation = selectOrientation.value;

        if (orientation === 'flat-top') {
            valHexFlatWidth.textContent = Math.round(size * Math.sqrt(3));
            valHexTotalHeight.textContent = Math.round(size * 2);
        } else {
            valHexFlatWidth.textContent = Math.round(size * Math.sqrt(3));
            valHexTotalHeight.textContent = Math.round(size * 2);
        }
    }

    // Automatyczny zapis do LocalStorage
    function saveProjectState() {
        const layoutData = {
            grid: {
                columns: parseInt(inputCols.value) || 4,
                rows: parseInt(inputRows.value) || 3,
                hexSize: parseFloat(inputHexSize.value) || 100,
                orientation: selectOrientation.value,
                stagger: selectStagger.value,
                gap: parseFloat(inputGap.value) || 2,
                dpi: selectDpi.value,
                exportFormat: selectFormat.value,
                exportQuality: parseInt(inputQuality.value) || 90,
                singleImageOffsetX: gridManager.config.singleImageOffsetX || 0,
                singleImageOffsetY: gridManager.config.singleImageOffsetY || 0,
                singleImageScale: gridManager.config.singleImageScale || 1.0,
                halfHexes: chkHalfHexes?.checked || false
            },
            bed: {
                verify: chkBedVerify.checked,
                sizeX: parseFloat(inputBedX.value) || 256,
                sizeY: parseFloat(inputBedY.value) || 256
            },
            frame: {
                enable: chkFrameEnable.checked,
                type: selectFrameType.value,
                width: parseFloat(inputFrameWidth.value) || 2,
                clearance: parseFloat(inputFrameClearance.value) || 0.2,
                height: parseFloat(inputFrameHeight?.value) || 10,
                sleeveBase: parseFloat(inputFrameSleeveBase?.value) || 1.2,
                color: inputFrameColor.value,
                syncWidth: chkSyncFrameWidth ? chkSyncFrameWidth.checked : true
            },
            relief: {
                enable: chkReliefEnable.checked,
                height: parseFloat(inputReliefHeight.value) || 2.0,
                baseThickness: parseFloat(inputReliefBaseThickness.value) || 1.2,
                invert: chkReliefInvert.checked,
                sectors: parseInt(inputReliefSectors.value) || 120,
                rings: parseInt(inputReliefRings.value) || 60,
                blur: parseFloat(inputReliefBlur.value) || 1.5
            },
            hanger: {
                clearance: parseFloat(inputHangerClearance.value) || 0.3,
                baseThickness: parseFloat(inputHangerBaseThickness.value) || 1.2,
                ridgeHeight: parseFloat(inputHangerRidgeHeight.value) || 2.0,
                armWidth: parseFloat(inputHangerArmWidth.value) || 12,
                armLength: parseFloat(inputHangerArmLength.value) || 30
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
        localStorage.setItem('hexsplitter_project_layout', JSON.stringify(layoutData));
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
    const handleSingleImageZoomChange = async (val) => {
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
                activeImg.zoom = intVal / 100;
                await DBStore.updateZoom(activeImg.id, activeImg.zoom);
                
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
    dropzone.addEventListener('click', () => fileInput.click());
    
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
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
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            try {
                const imgObj = await imageProcessor.addImage(file);
                // Zapisz fizyczny blob pliku do trwałego IndexedDB
                await DBStore.save(imgObj.id, imgObj.name, file, imgObj.width, imgObj.height);
                addDraggableImageToUI(imgObj);
            } catch (err) {
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
    }

    function addDraggableImageToUI(imageObj) {
        const emptyText = imageList.querySelector('.empty-list-text');
        if (emptyText) emptyText.remove();

        const item = document.createElement('div');
        item.className = 'image-item';
        item.draggable = true;
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
        btnRemove.addEventListener('click', async (e) => {
            e.stopPropagation();
            imageProcessor.removeImage(imageObj.id);
            // Usuń z IndexedDB
            await DBStore.delete(imageObj.id);
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

        const syncRotation = async (val) => {
            let angle = parseInt(val);
            if (isNaN(angle)) angle = 0;
            if (angle < 0) angle = 0;
            if (angle > 360) angle = 360;

            if (parseInt(rotSlider.value) !== angle) rotSlider.value = angle;
            if (parseInt(rotNumberInput.value) !== angle) rotNumberInput.value = angle;

            imageProcessor.rotateImage(imageObj.id, angle);
            await DBStore.updateRotation(imageObj.id, angle);
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

        const syncZoom = async (val) => {
            let intVal = parseInt(val);
            if (isNaN(intVal)) intVal = 100;
            if (intVal < 100) intVal = 100;
            if (intVal > 500) intVal = 500;

            if (parseInt(zoomSlider.value) !== intVal) zoomSlider.value = intVal;
            if (parseInt(zoomNumberInput.value) !== intVal) zoomNumberInput.value = intVal;

            imageObj.zoom = intVal / 100;
            await DBStore.updateZoom(imageObj.id, imageObj.zoom);

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
        };

        zoomSlider.addEventListener('input', () => syncZoom(zoomSlider.value));
        zoomNumberInput.addEventListener('input', () => syncZoom(zoomNumberInput.value));

        // Zapobiegaj Drag&Drop przy interakcji z suwakami i polami tekstowymi
        control.addEventListener('mouseenter', () => {
            item.setAttribute('draggable', 'false');
        });
        control.addEventListener('mouseleave', () => {
            item.setAttribute('draggable', 'true');
        });

        item.appendChild(control);

        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', imageObj.id);
            item.classList.add('dragging');
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
        });

        imageList.appendChild(item);
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

    // Zapis projektu do pliku .hexproj (ZIP z grafikami i jsonem)
    async function saveProjectToFile() {
        try {
            const zip = new JSZip();

            // Kompiluj dane stanu projektu (takie same jak do localStorage)
            const layoutData = {
                grid: {
                    columns: parseInt(inputCols.value) || 4,
                    rows: parseInt(inputRows.value) || 3,
                    hexSize: parseFloat(inputHexSize.value) || 100,
                    orientation: selectOrientation.value,
                    stagger: selectStagger.value,
                    gap: parseFloat(inputGap.value) || 2,
                    dpi: selectDpi.value,
                    exportFormat: selectFormat.value,
                    exportQuality: parseInt(inputQuality.value) || 90,
                    singleImageOffsetX: gridManager.config.singleImageOffsetX || 0,
                    singleImageOffsetY: gridManager.config.singleImageOffsetY || 0,
                    singleImageScale: gridManager.config.singleImageScale || 1.0,
                    halfHexes: chkHalfHexes?.checked || false
                },
                bed: {
                    verify: chkBedVerify.checked,
                    sizeX: parseFloat(inputBedX.value) || 256,
                    sizeY: parseFloat(inputBedY.value) || 256
                },
                frame: {
                    enable: chkFrameEnable.checked,
                    type: selectFrameType.value,
                    width: parseFloat(inputFrameWidth.value) || 2,
                    clearance: parseFloat(inputFrameClearance.value) || 0.2,
                    height: parseFloat(inputFrameHeight?.value) || 10,
                    sleeveBase: parseFloat(inputFrameSleeveBase?.value) || 1.2,
                    color: inputFrameColor.value,
                    syncWidth: chkSyncFrameWidth ? chkSyncFrameWidth.checked : true
                },
                relief: {
                    enable: chkReliefEnable.checked,
                    height: parseFloat(inputReliefHeight.value) || 2.0,
                    baseThickness: parseFloat(inputReliefBaseThickness.value) || 1.2,
                    invert: chkReliefInvert.checked,
                    sectors: parseInt(inputReliefSectors.value) || 120,
                    rings: parseInt(inputReliefRings.value) || 60,
                    blur: parseFloat(inputReliefBlur.value) || 1.5
                },
                hanger: {
                    clearance: parseFloat(inputHangerClearance.value) || 0.3,
                    baseThickness: parseFloat(inputHangerBaseThickness.value) || 1.2,
                    ridgeHeight: parseFloat(inputHangerRidgeHeight.value) || 2.0,
                    armWidth: parseFloat(inputHangerArmWidth.value) || 12,
                    armLength: parseFloat(inputHangerArmLength.value) || 30
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

            const savedImages = await DBStore.getAll();
            const imagesMeta = [];

            savedImages.forEach(img => {
                imagesMeta.push({
                    id: img.id,
                    name: img.name,
                    width: img.width,
                    height: img.height,
                    rotation: img.rotation,
                    zoom: img.zoom,
                    filename: `images/${img.id}`
                });
                zip.file(`images/${img.id}`, img.blob);
            });

            const projectData = {
                layout: layoutData,
                images: imagesMeta
            };

            zip.file('project.json', JSON.stringify(projectData, null, 2));

            const content = await zip.generateAsync({ type: 'blob' });
            saveAs(content, 'project.hexproj');
        } catch (err) {
            console.error('Błąd zapisu projektu:', err);
            alert('Wystąpił błąd podczas eksportu projektu do pliku.');
        }
    }

    // Wczytanie projektu z pliku .hexproj
    async function loadProjectFromFile(file) {
        try {
            const zip = await JSZip.loadAsync(file);
            const projectJsonFile = zip.file('project.json');
            if (!projectJsonFile) {
                alert('Błąd: Wybrany plik nie zawiera poprawnych danych projektu.');
                return;
            }

            const projectText = await projectJsonFile.async('text');
            const projectData = JSON.parse(projectText);

            if (!projectData.layout || !projectData.images) {
                alert('Błąd: Niepoprawny format danych projektu.');
                return;
            }

            // Wyczyść bieżący projekt
            gridManager.clearImageAssignments();
            await DBStore.clear();
            imageProcessor.clearAll();

            // Importuj obrazy
            for (const imgMeta of projectData.images) {
                const imgFile = zip.file(imgMeta.filename);
                if (imgFile) {
                    const blob = await imgFile.async('blob');
                    await DBStore.save(imgMeta.id, imgMeta.name, blob, imgMeta.width, imgMeta.height);
                    await DBStore.updateRotation(imgMeta.id, imgMeta.rotation || 0);
                    await DBStore.updateZoom(imgMeta.id, imgMeta.zoom || 1.0);
                }
            }

            // Zapisz układ w localStorage
            localStorage.setItem('hexsplitter_project_layout', JSON.stringify(projectData.layout));

            // Przeładuj stronę, aby wczytać stan na czysto
            window.location.reload();
        } catch (err) {
            console.error('Błąd wczytywania projektu:', err);
            alert('Wystąpił błąd podczas wczytywania projektu z pliku.');
        }
    }

    // Eventy zapisu i wczytywania projektu z pliku
    document.getElementById('btn-save-project').addEventListener('click', saveProjectToFile);
    
    const projectFileInput = document.getElementById('project-file-input');
    document.getElementById('btn-load-project').addEventListener('click', () => {
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
        if (confirm(i18n.t('confirm_reset'))) {
            gridManager.clearImageAssignments();
            gridManager.setAllCellsStatus(true);
            
            // Wyczyść IndexedDB i ImageProcessor
            await DBStore.clear();
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
            reliefHeight: parseFloat(inputReliefHeight.value) || 2.0,
            baseThickness: parseFloat(inputReliefBaseThickness.value) || 1.2,
            invert: chkReliefInvert.checked,
            sectors: parseInt(inputReliefSectors.value) || 120,
            rings: parseInt(inputReliefRings.value) || 60,
            blur: parseFloat(inputReliefBlur.value) || 1.5
        };
        await exporter.exportHexes3DStl(options);
    });

    // Eksport uchwytu Y (STL)
    document.getElementById('btn-export-hanger').addEventListener('click', () => {
        const gridConfig = gridManager.config;
        const hangerConfig = {
            clearance: parseFloat(inputHangerClearance.value) || 0.3,
            baseThickness: parseFloat(inputHangerBaseThickness.value) || 1.2,
            ridgeHeight: parseFloat(inputHangerRidgeHeight.value) || 2.0,
            armWidth: parseFloat(inputHangerArmWidth.value) || 12,
            armLength: parseFloat(inputHangerArmLength.value) || 30
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

    // --- PRZYWRACANIE STANU PROJEKTU PRZY URUCHOMIENIU ---
    async function loadSavedProjectState() {
        try {
            // 1. Wczytaj obrazy z IndexedDB
            const savedImages = await DBStore.getAll();
            if (savedImages && savedImages.length > 0) {
                const emptyText = imageList.querySelector('.empty-list-text');
                if (emptyText) emptyText.remove();

                for (const saved of savedImages) {
                    const img = new Image();
                    const url = URL.createObjectURL(saved.blob);
                    
                    await new Promise((resolve) => {
                        img.onload = resolve;
                        img.src = url;
                    });

                    const imageObj = {
                        id: saved.id,
                        name: saved.name,
                        imgElement: img,
                        width: saved.width,
                        height: saved.height,
                        src: url,
                        rotation: saved.rotation || 0,
                        zoom: saved.zoom || 1.0
                    };

                    imageProcessor.images.set(saved.id, imageObj);
                    if (imageObj.rotation !== 0) {
                        imageProcessor.rotateImage(saved.id, 0); // Odtwórz obrócony canvas buforowany
                    }
                    addDraggableImageToUI(imageObj);
                }
                updateMainImageSelector();
            }

            // 2. Wczytaj layout z localStorage
            const layoutStr = localStorage.getItem('hexsplitter_project_layout');
            if (layoutStr) {
                const layout = JSON.parse(layoutStr);

                // Przywróć wartości UI
                if (layout.grid) {
                    if (layout.grid.columns !== undefined) inputCols.value = layout.grid.columns;
                    if (layout.grid.rows !== undefined) inputRows.value = layout.grid.rows;
                    if (layout.grid.hexSize !== undefined) inputHexSize.value = layout.grid.hexSize;
                    if (layout.grid.orientation !== undefined) selectOrientation.value = layout.grid.orientation;
                    if (layout.grid.stagger !== undefined) selectStagger.value = layout.grid.stagger;
                    if (layout.grid.gap !== undefined) inputGap.value = layout.grid.gap;
                    if (layout.grid.dpi !== undefined) selectDpi.value = layout.grid.dpi;
                    if (layout.grid.halfHexes !== undefined && chkHalfHexes) chkHalfHexes.checked = layout.grid.halfHexes;
                    if (layout.grid.exportFormat !== undefined && selectFormat) {
                        selectFormat.value = layout.grid.exportFormat;
                        if (layout.grid.exportFormat === 'jpg') {
                            if (jpgQualityGroup) jpgQualityGroup.classList.remove('hidden');
                        } else {
                            if (jpgQualityGroup) jpgQualityGroup.classList.add('hidden');
                        }
                    }
                    if (layout.grid.exportQuality !== undefined && inputQuality) {
                        inputQuality.value = layout.grid.exportQuality;
                        if (valQuality) valQuality.textContent = `${layout.grid.exportQuality}%`;
                    }
                    
                    gridManager.config.singleImageOffsetX = layout.grid.singleImageOffsetX || 0;
                    gridManager.config.singleImageOffsetY = layout.grid.singleImageOffsetY || 0;
                    gridManager.config.singleImageScale = layout.grid.singleImageScale || 1.0;
                    if (inputSingleImageZoom) {
                        inputSingleImageZoom.value = Math.round((layout.grid.singleImageScale || 1.0) * 100);
                    }
                    if (valSingleImageZoom) {
                        valSingleImageZoom.value = Math.round((layout.grid.singleImageScale || 1.0) * 100);
                    }
                }

                if (layout.bed) {
                    if (layout.bed.verify !== undefined) chkBedVerify.checked = layout.bed.verify;
                    if (layout.bed.sizeX !== undefined) inputBedX.value = layout.bed.sizeX;
                    if (layout.bed.sizeY !== undefined) inputBedY.value = layout.bed.sizeY;
                }

                if (layout.frame) {
                    if (layout.frame.enable !== undefined) chkFrameEnable.checked = layout.frame.enable;
                    if (layout.frame.type !== undefined) selectFrameType.value = layout.frame.type;
                    if (layout.frame.width !== undefined) inputFrameWidth.value = layout.frame.width;
                    if (layout.frame.clearance !== undefined) inputFrameClearance.value = layout.frame.clearance;
                    if (layout.frame.height !== undefined && inputFrameHeight) inputFrameHeight.value = layout.frame.height;
                    if (layout.frame.sleeveBase !== undefined && inputFrameSleeveBase) inputFrameSleeveBase.value = layout.frame.sleeveBase;
                    if (layout.frame.color !== undefined) inputFrameColor.value = layout.frame.color;
                    if (layout.frame.syncWidth !== undefined && chkSyncFrameWidth) {
                        chkSyncFrameWidth.checked = layout.frame.syncWidth;
                    }
                }

                if (layout.relief) {
                    if (layout.relief.enable !== undefined) chkReliefEnable.checked = layout.relief.enable;
                    if (layout.relief.height !== undefined) inputReliefHeight.value = layout.relief.height;
                    if (layout.relief.baseThickness !== undefined) inputReliefBaseThickness.value = layout.relief.baseThickness;
                    if (layout.relief.invert !== undefined) chkReliefInvert.checked = layout.relief.invert;
                    if (layout.relief.sectors !== undefined) inputReliefSectors.value = layout.relief.sectors;
                    if (layout.relief.rings !== undefined) inputReliefRings.value = layout.relief.rings;
                    if (layout.relief.blur !== undefined && inputReliefBlur) {
                        inputReliefBlur.value = layout.relief.blur;
                        if (valReliefBlur) valReliefBlur.textContent = `${layout.relief.blur}px`;
                    }
                }

                if (layout.hanger) {
                    if (layout.hanger.clearance !== undefined) inputHangerClearance.value = layout.hanger.clearance;
                    if (layout.hanger.baseThickness !== undefined) inputHangerBaseThickness.value = layout.hanger.baseThickness;
                    if (layout.hanger.ridgeHeight !== undefined) inputHangerRidgeHeight.value = layout.hanger.ridgeHeight;
                    if (layout.hanger.armWidth !== undefined) inputHangerArmWidth.value = layout.hanger.armWidth;
                    if (layout.hanger.armLength !== undefined) inputHangerArmLength.value = layout.hanger.armLength;
                }

                if (layout.previewOptions) {
                    if (layout.previewOptions.showGaps !== undefined) chkPreviewGaps.checked = layout.previewOptions.showGaps;
                    if (layout.previewOptions.showLabels !== undefined) chkPreviewLabels.checked = layout.previewOptions.showLabels;
                    if (layout.previewOptions.showFrames !== undefined) chkPreviewFrames.checked = layout.previewOptions.showFrames;
                    if (layout.previewOptions.showRuler !== undefined && chkPreviewRuler) chkPreviewRuler.checked = layout.previewOptions.showRuler;
                    if (layout.previewOptions.showHangers !== undefined && chkPreviewHangers) chkPreviewHangers.checked = layout.previewOptions.showHangers;
                    if (layout.previewOptions.background !== undefined) selectPreviewBg.value = layout.previewOptions.background;
                    
                    preview.options.showGaps = chkPreviewGaps.checked;
                    preview.options.showLabels = chkPreviewLabels.checked;
                    preview.options.showFrames = chkPreviewFrames.checked;
                    preview.options.showRuler = chkPreviewRuler ? chkPreviewRuler.checked : true;
                    preview.options.showHangers = chkPreviewHangers ? chkPreviewHangers.checked : false;
                    preview.options.background = selectPreviewBg.value;
                }

                // Tryb obrazu
                radioImageModes.forEach(r => {
                    r.checked = (r.value === layout.imageMode);
                });

                imageProcessor.activeImageId = layout.activeImageId;
                updateMainImageSelector();

                // Zaaplikuj config siatki
                gridManager.updateConfig(readConfigFromUI());

                // Nadpisz stany komórek
                if (layout.cells) {
                    layout.cells.forEach(savedCell => {
                        const cell = gridManager.getCell(savedCell.q, savedCell.r);
                        if (cell) {
                            cell.enabled = savedCell.enabled;
                            cell.imageId = savedCell.imageId;
                            cell.cropRegion = savedCell.cropRegion;
                            cell.groupId = savedCell.groupId;
                            cell.groupShiftX = savedCell.groupShiftX;
                            cell.groupShiftY = savedCell.groupShiftY;
                            cell.groupZoom = savedCell.groupZoom;
                        }
                    });
                }

                // Aktualizuj widoczność
                handleBedVerifyChange();
                handleFrameConfigChange();
                handleReliefConfigChange();
                
                if (layout.imageMode === 'single') {
                    singleImageWrapper.classList.remove('hidden');
                } else {
                    singleImageWrapper.classList.add('hidden');
                }
            } else {
                handleBedVerifyChange();
                handleFrameConfigChange();
                handleReliefConfigChange();
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

    // Nasłuchiwanie zmian języka
    document.addEventListener('languagechange', () => {
        if (imageProcessor.getAllImages().length === 0) {
            imageList.innerHTML = `<p class="empty-list-text">${i18n.t('no_images_loaded')}</p>`;
        }
        updateMainImageSelector();
        updateStatusText();
        updateHexDimensionLabels();
        const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
        if (activeTab === 'tab-instructions') {
            exporter.generateAssemblyInstructions();
        }
    });

    // Rozpocznij przywracanie stanu po wczytaniu DOM
    await loadSavedProjectState();
});
