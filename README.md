# HexSplitter — Hexagonal Wall Planner & Slicer

[English version below](#english-version)

**HexSplitter** to w pełni kliencka aplikacja webowa służąca do planowania, wizualizacji i cięcia obrazów na siatki sześciokątne (heksagony). Idealna do tworzenia dekoracji ściennych, kolaży zdjęć lub ramek do druku 3D.

---

## 🛠 Funkcje

- **Interaktywny planer siatki**: Aktywuj lub dezaktywuj poszczególne heksagony, aby tworzyć niestandardowe kształty ścian. Wsparcie dla orientacji **Flat-Top** i **Pointy-Top** oraz przesunięcia pierwszego rzędu.
- **Dwa tryby dopasowania**:
  - **Jeden obraz**: Rozciągnięcie jednego zdjęcia na całą kompozycję heksagonów.
  - **Wiele obrazów**: Umieszczanie i kadrowanie oddzielnych zdjęć w konkretnych heksagonach.
- **Wizualizacja ścienna**: Konfiguracja przerw dylatacyjnych, etykiet, ramek oraz linijki pomocniczej. Posiada podgląd **AMS (kwantyzacja kolorów)** symulujący ograniczenia druku 3D.
- **Weryfikacja stołu drukarki**: Ostrzega, gdy wymiary heksagonu przekraczają obszar roboczy drukarki 3D (np. 256x256 mm).
- **Generowanie ramek do druku 3D**: Automatyczne tworzenie obrysów, płytek tylnych lub wsuwek (sleeve z wypustką) z regulowaną tolerancją (luzem) i szerokością.
- **Masowy eksport**: Pobieranie pociętych grafik (PNG/JPG z ustawieniem DPI/jakości) oraz ramek (PNG/SVG) w archiwach `.zip`.
- **Instrukcja montażu**: Generowanie gotowego do druku przewodnika PDF z mapowaniem pozycji, wymiarami i kodami heksagonów.
- **Wielojęzyczność**: Pełne wsparcie dla języka polskiego i angielskiego.

---

## 🚀 Jak uruchomić

Aplikacja działa w 100% po stronie przeglądarki (client-side) i nie wymaga serwera backendowego:
1. Sklonuj repozytorium.
2. Otwórz plik `index.html` bezpośrednio w przeglądarce lub uruchom lokalny serwer:
   ```bash
   npx serve .
   ```

---

## 🤖 Stworzone przez AI

Ten projekt został w całości zaprojektowany, napisany i zoptymalizowany przez **Antigravity** — zaawansowanego agenta AI od **Google DeepMind** — we współpracy z użytkownikiem. Każda linijka kodu HTML, CSS i JavaScript powstała i była rozwijana w ramach sesji programowania z AI.

---

## English Version

**HexSplitter** is a fully client-side web application designed to help users plan, visualize, and slice images into hexagonal grids for wall art, photo grids, or 3D-printed hex frames.

### 🛠 Features

- **Interactive Layout Grid**: Add/remove individual hexagons to create custom wall shapes. Support for both **Flat-Top** and **Pointy-Top** orientations, plus row alignment offsets.
- **Two Image Modes**:
  - **Single Image**: Stretches a single photo across the entire hexagonal arrangement.
  - **Multi Image**: Place and position different photos inside specific hexagons.
- **Visual Wall Preview**: Adjust dilatation gaps, show cell labels, draw frames, and toggle a scale ruler. Includes an **AMS Preview (Color Quantization)** to simulate 3D print color limits.
- **3D Print Bed Verification**: Warns if a hexagon exceeds the specified 3D printer bed size (e.g., 256x256 mm).
- **Customizable 3D Print Frames**: Generate outlines, backing plates, or sleeves (with lip) with configurable clearance and widths.
- **Batch Export**: Downloads sliced hexagon graphics (PNG/JPG with custom DPI/quality) and reusable frames (PNG/SVG) in separate `.zip` archives.
- **Assembly Guide**: Generates a print-ready PDF guide with placement code tags, dimensions, and layout mapping.
- **Bilingual Support**: Fully localized in English and Polish.

### 🚀 How to Run

Since HexSplitter runs entirely in the browser without any backend requirements:
1. Clone the repository.
2. Open `index.html` directly in your web browser, or serve it using a lightweight local server:
   ```bash
   npx serve .
   ```

### 🤖 Created by AI

This entire project was designed, implemented, and refined by **Antigravity**, a powerful agentic AI coding assistant developed by **Google DeepMind**, working in tandem with the project owner. Every line of HTML, CSS, and JS was written and optimized by the AI based on iterative requirements.
