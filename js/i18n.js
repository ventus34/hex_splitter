const translations = {
    en: {
        app_title: "HexSplitter - Hexagonal Wall Planner",
        app_subtitle: "Hexagonal Wall Planner & Slicer",
        tab_planner: "Planning",
        tab_preview: "Wall Preview",
        tab_instructions: "Assembly Guide",
        btn_reset_project: "Clear project",
        image_library: "Image Library",
        drag_images_here: "Drag images here",
        or_click_to_select: "or click to select files",
        no_images_loaded: "No images loaded",
        image_mode_title: "Image Assignment Mode",
        single_image_wall: "Single image on entire wall",
        single_image_desc: "One image stretched/fitted across the hex grid",
        multi_image_wall: "Multiple images (manual layout)",
        multi_image_desc: "Drag individual images onto specific hexes",
        active_wall_image: "Active image for the wall",
        select_image_placeholder: "Select image...",
        image_zoom: "Image zoom:",
        zoom_in: "Zoom in",
        zoom_out: "Zoom out",
        zoom_fit: "Fit to screen",
        activate_all: "Activate all",
        deactivate_all: "Deactivate all",
        mode_grid_title: "Draw grid (Activate hexes)",
        mode_grid: "Grid",
        mode_image_title: "Move and crop images in hexes",
        mode_image: "Move photo",
        status_grid_mode: "Use LMB to activate/deactivate hexes from the layout",
        status_image_mode: "Drag images within hexes (multi) or the entire background (single)",
        show_gaps: "Show gaps",
        show_labels: "Show labels",
        show_frames: "Show frames",
        show_ruler: "Show ruler",
        ams_preview: "Color Quantization (AMS Preview)",
        colors_4: "4 colors",
        colors_8: "8 colors",
        colors_16: "16 colors",
        preview_bg: "Preview background:",
        bg_transparent: "Transparent (checkerboard)",
        bg_dark: "Dark background (anthracite)",
        bg_light: "Light background (room)",
        bg_wall: "Wall (concrete texture)",
        print_instructions: "Print instructions (PDF)",
        instructions_header: "Hexagonal Wall Assembly Instructions",
        stat_total: "Number of hexes",
        stat_dimensions: "Total dimensions",
        stat_hexsize: "Hex size (S)",
        stat_gap: "Gap size",
        layout_preview_title: "1. Wall Layout Preview",
        hex_list_title: "2. Detailed Hex List",
        th_code: "Code",
        th_position: "Position",
        th_graphic: "Hex graphic",
        th_frame: "Frame shape",
        th_desc: "Description & tech specs",
        no_active_hexes: "No active hexes in the project.",
        col_row_info: "Column <strong>{col}</strong><br>Row <strong>{row}</strong>",
        no_graphic: "No graphic",
        frames_disabled: "Frames disabled",
        gen_error: "Generation error",
        print_size: "Print size:",
        source_image: "Source image:",
        outer_frame_width: "Outer frame width:",
        inst_mount_desc: "Mount the element on the wall according to the position in the diagram above.",
        not_assigned: "Not assigned",
        generated_date: "Generated: {date} at {time}",
        grid_config: "Grid Configuration",
        columns: "Columns",
        rows: "Rows",
        hex_size_s: "Hex size (S)",
        circumradius_hint: "circumradius (mm)",
        flat_width: "Width (flat-to-flat):",
        total_height: "Total height:",
        orientation: "Orientation",
        flat_top: "Flat-Top (flat side up)",
        pointy_top: "Pointy-Top (pointy side up)",
        stagger_label: "First row/column alignment",
        stagger_left_pointy: "First row protruding to the left (Standard)",
        stagger_right_pointy: "First row protruding to the right",
        stagger_left_flat: "First column protruding to the top (Standard)",
        stagger_right_flat: "First column protruding to the bottom",
        dilatation_gap: "Dilatation gap (mm)",
        gap_info: "Dilatation gap between adjacent hex tiles.",
        export_dpi: "DPI for image export",
        dpi_original: "Original (no scaling)",
        dpi_72: "72 DPI (Low resolution)",
        dpi_150: "150 DPI (Medium - optimal)",
        dpi_300: "300 DPI (High - 3D print)",
        dpi_info: "Directly affects the pixel size of the cut images.",
        export_format: "Image format",
        jpeg_quality: "JPEG Quality:",
        bed_verify: "Verify print bed dimensions",
        bed_x: "Bed X (mm)",
        bed_y: "Bed Y (mm)",
        bed_warning: "Elements do not fit on the print bed!",
        frame_config: "Frame / Sleeve Configuration",
        frame_enable: "Enable frame generation",
        frame_type: "Frame type",
        frame_outline: "Outline (Hollow frame)",
        frame_backing: "Backing plate",
        frame_sleeve: "Sleeve (with lip)",
        frame_width: "Frame width (mm)",
        sync_width: "Autosync with gap",
        frame_width_info: "When width matches the gap, frames touch without overlapping.",
        frame_clearance: "Clearance / Tolerance (mm)",
        frame_clearance_info: "Clearance between the hex print and the frame interior.",
        frame_color: "Visualization color",
        export_section: "Export",
        btn_export_hexes: "Download Hexes (.ZIP)",
        btn_export_frames_png: "Frames ZIP (PNG)",
        btn_export_frames_svg: "Frames ZIP (SVG)",
        preparing_files: "Preparing files...",
        generating_hex_images: "Generating hex images...",
        generating_png_frames: "Generating PNG frames...",
        generating_svg_frames: "Generating SVG frames...",
        compressing_zip: "Compressing ZIP archive...",
        confirm_reset: "Are you sure you want to clear the entire project and start over?",
        alert_no_hexes: "No active hexes to export!",
        alert_no_images: "Assign images to hexes first!",
        alert_zip_error: "An error occurred during ZIP packing: ",
        alert_frames_disabled: "Frame generation is disabled in the side panel!",
        alert_no_frames: "No active hexes to export frames for!",
        alert_frame_png_error: "An error occurred during PNG frame generation: ",
        alert_frame_svg_error: "An error occurred during SVG frame generation: "
    },
    pl: {
        app_title: "HexSplitter - Planer ścienny z heksów",
        app_subtitle: "Planer i slicer ścienny",
        tab_planner: "Planowanie",
        tab_preview: "Podgląd Ściany",
        tab_instructions: "Instrukcja Montażu",
        btn_reset_project: "Wyczyść projekt",
        image_library: "Biblioteka Grafik",
        drag_images_here: "Przeciągnij grafiki tutaj",
        or_click_to_select: "lub kliknij aby wybrać pliki",
        no_images_loaded: "Brak załadowanych grafik",
        image_mode_title: "Tryb Przypisania Grafik",
        single_image_wall: "Jedna grafika na całą ścianę",
        single_image_desc: "Jedna grafika rozciągnięta/dopasowana na siatkę heksów",
        multi_image_wall: "Wiele grafik (układ ręczny)",
        multi_image_desc: "Przeciągnij pojedyncze grafiki na konkretne heksy",
        active_wall_image: "Aktywna grafika dla ściany",
        select_image_placeholder: "Wybierz grafikę...",
        image_zoom: "Powiększenie obrazu:",
        zoom_in: "Powiększ",
        zoom_out: "Pomniejsz",
        zoom_fit: "Dopasuj do ekranu",
        activate_all: "Aktywuj wszystkie",
        deactivate_all: "Dezaktywuj wszystkie",
        mode_grid_title: "Rysowanie siatki (Aktywacja heksów)",
        mode_grid: "Siatka",
        mode_image_title: "Przesuwanie i kadrowanie obrazów w heksach",
        mode_image: "Przesuń foto",
        status_grid_mode: "Użyj LPM aby zaznaczyć/odznaczyć heksy z układu",
        status_image_mode: "Przeciągaj obrazy w heksach (multi) lub całe tło (single)",
        show_gaps: "Pokazuj szczeliny",
        show_labels: "Pokazuj etykiety",
        show_frames: "Pokazuj ramki",
        show_ruler: "Pokazuj miarkę",
        ams_preview: "Kwantyzacja kolorów (Podgląd AMS)",
        colors_4: "4 kolory",
        colors_8: "8 kolorów",
        colors_16: "16 kolorów",
        preview_bg: "Tło podglądu:",
        bg_transparent: "Transparentne (szachownica)",
        bg_dark: "Ciemne tło (antracyt)",
        bg_light: "Jasne tło (pokój)",
        bg_wall: "Ściana (betonowa tekstura)",
        print_instructions: "Wydrukuj instrukcję (PDF)",
        instructions_header: "Instrukcja Montażu Ściany Heksagonalnej",
        stat_total: "Liczba heksów",
        stat_dimensions: "Wymiary całkowite",
        stat_hexsize: "Rozmiar heksa (S)",
        stat_gap: "Rozmiar szczeliny",
        layout_preview_title: "1. Podgląd Układu Ściany",
        hex_list_title: "2. Szczegółowy Wykaz Heksów",
        th_code: "Kod",
        th_position: "Pozycja",
        th_graphic: "Grafika heksu",
        th_frame: "Kształt ramki",
        th_desc: "Opis i parametry techniczne",
        no_active_hexes: "Brak aktywnych heksów w projekcie.",
        col_row_info: "Kolumna <strong>{col}</strong><br>Wiersz <strong>{row}</strong>",
        no_graphic: "Brak grafiki",
        frames_disabled: "Ramki wyłączone",
        gen_error: "Błąd generowania",
        print_size: "Rozmiar druku:",
        source_image: "Grafika źródłowa:",
        outer_frame_width: "Szerokość zewnętrzna ramki:",
        inst_mount_desc: "Zamocuj element na ścianie zgodnie z pozycją na schemacie powyżej.",
        not_assigned: "Brak przypisania",
        generated_date: "Wygenerowano: {date} o {time}",
        grid_config: "Konfiguracja Siatki",
        columns: "Kolumny",
        rows: "Wiersze",
        hex_size_s: "Rozmiar heksa (S)",
        circumradius_hint: "circumradius (mm)",
        flat_width: "Szerokość (od boku do boku):",
        total_height: "Wysokość całkowita:",
        orientation: "Orientacja",
        flat_top: "Flat-Top (płaski na górze)",
        pointy_top: "Pointy-Top (ostry na górze)",
        stagger_label: "Rozpoczęcie rzędów/kolumn",
        stagger_left_pointy: "Pierwszy rząd wysunięty w lewo (Standard)",
        stagger_right_pointy: "Pierwszy rząd wysunięty w prawo",
        stagger_left_flat: "Pierwsza kolumna wysunięta w górę (Standard)",
        stagger_right_flat: "Pierwsza kolumna wysunięta w dół",
        dilatation_gap: "Szczelina dylatacyjna (mm)",
        gap_info: "Odstęp dylatacyjny między sąsiednimi płytkami heksów.",
        export_dpi: "DPI dla eksportu grafik",
        dpi_original: "Oryginalna (bez skalowania)",
        dpi_72: "72 DPI (Niska rozdzielczość)",
        dpi_150: "150 DPI (Średnia - optymalna)",
        dpi_300: "300 DPI (Wysoka - druk 3D)",
        dpi_info: "Wpływa bezpośrednio na wielkość w pikselach wyciętych grafik.",
        export_format: "Format zapisu grafik",
        jpeg_quality: "Jakość JPEG:",
        bed_verify: "Weryfikacja wymiarów stołu",
        bed_x: "Stół X (mm)",
        bed_y: "Stół Y (mm)",
        bed_warning: "Elementy nie mieszczą się na stole!",
        frame_config: "Konfiguracja Ramek / Obwolut",
        frame_enable: "Włącz generowanie ramek",
        frame_type: "Typ ramki",
        frame_outline: "Obwódka / Outline (Hollow frame)",
        frame_backing: "Podkładka / Backing plate",
        frame_sleeve: "Obwoluta / Sleeve (z rantem)",
        frame_width: "Szerokość ramki (mm)",
        sync_width: "Autosync ze szczeliną",
        frame_width_info: "Gdy szerokość odpowiada szczelinie, ramki stykają się bez nakładania.",
        frame_clearance: "Tolerancja / Luz (mm)",
        frame_clearance_info: "Luz między wydrukiem heksu a wnętrzem ramki.",
        frame_color: "Kolor do wizualizacji",
        export_section: "Eksport",
        btn_export_hexes: "Pobierz Heksy (.ZIP)",
        btn_export_frames_png: "Ramki ZIP (PNG)",
        btn_export_frames_svg: "Ramki ZIP (SVG)",
        preparing_files: "Przygotowywanie plików...",
        generating_hex_images: "Generowanie grafik heksów...",
        generating_png_frames: "Generowanie ramek PNG...",
        generating_svg_frames: "Generowanie ramek SVG...",
        compressing_zip: "Kompresowanie archiwum ZIP...",
        confirm_reset: "Czy na pewno chcesz wyczyścić cały projekt i zacząć od nowa?",
        alert_no_hexes: "Brak aktywnych heksów do wyeksportowania!",
        alert_no_images: "Najpierw przypisz grafiki do heksów!",
        alert_zip_error: "Wystąpił błąd podczas pakowania ZIP: ",
        alert_frames_disabled: "Generowanie ramek jest wyłączone w panelu bocznym!",
        alert_no_frames: "Brak aktywnych heksów, dla których można wyeksportować ramki!",
        alert_frame_png_error: "Wystąpił błąd podczas generowania ramek PNG: ",
        alert_frame_svg_error: "Wystąpił błąd podczas generowania ramek SVG: "
    }
};

class I18nManager {
    constructor() {
        this.locale = (typeof localStorage !== 'undefined') ? (localStorage.getItem('hexsplitter_locale') || 'en') : 'en';
        this.translations = translations;
    }

    setLocale(locale) {
        if (this.translations[locale]) {
            this.locale = locale;
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('hexsplitter_locale', locale);
            }
            this.translatePage();
            if (typeof document !== 'undefined') {
                document.dispatchEvent(new CustomEvent('languagechange', { detail: { locale } }));
            }
        }
    }

    t(key, params = {}) {
        const trans = this.translations[this.locale];
        if (!trans) return key;
        let str = trans[key] || this.translations['en'][key] || key;
        
        for (const [k, v] of Object.entries(params)) {
            str = str.replace(new RegExp(`{${k}}`, 'g'), v);
        }
        return str;
    }

    translatePage() {
        if (typeof document === 'undefined') return;
        // Translate all elements with data-i18n
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            el.innerHTML = this.t(key);
        });

        // Translate placeholders/titles if they have data-i18n-attr
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.dataset.i18nPlaceholder;
            el.placeholder = this.t(key);
        });

        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.dataset.i18nTitle;
            el.title = this.t(key);
        });
        
        // Update document title
        document.title = this.t('app_title');
    }
}

export const i18n = new I18nManager();
