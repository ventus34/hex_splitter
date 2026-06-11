/**
 * HangerGenerator - Generates 3D printable Y-hanger brackets as STL files.
 */

class STLWriter {
    constructor(name = "y_hanger") {
        this.name = name;
        this.triangles = [];
    }

    addTriangle(p1, p2, p3, normal = null) {
        if (!normal) {
            // Calculate face normal using cross product of (p2-p1) and (p3-p1)
            const ux = p2.x - p1.x;
            const uy = p2.y - p1.y;
            const uz = p2.z - p1.z;
            const vx = p3.x - p1.x;
            const vy = p3.y - p1.y;
            const vz = p3.z - p1.z;
            const nx = uy * vz - uz * vy;
            const ny = uz * vx - ux * vz;
            const nz = ux * vy - uy * vx;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (len > 0) {
                normal = { x: nx / len, y: ny / len, z: nz / len };
            } else {
                normal = { x: 0, y: 0, z: 1 };
            }
        }
        this.triangles.push({ p1, p2, p3, normal });
    }

    addBox(x1, y1, z1, x2, y2, z2) {
        const v = [
            { x: x1, y: y1, z: z1 }, // 0
            { x: x2, y: y1, z: z1 }, // 1
            { x: x2, y: y2, z: z1 }, // 2
            { x: x1, y: y2, z: z1 }, // 3
            { x: x1, y: y1, z: z2 }, // 4
            { x: x2, y: y1, z: z2 }, // 5
            { x: x2, y: y2, z: z2 }, // 6
            { x: x1, y: y2, z: z2 }  // 7
        ];
        
        // Bottom face (z1) - looking down
        this.addTriangle(v[0], v[2], v[1]);
        this.addTriangle(v[0], v[3], v[2]);
        // Top face (z2) - looking up
        this.addTriangle(v[4], v[5], v[6]);
        this.addTriangle(v[4], v[6], v[7]);
        // Front face (y1)
        this.addTriangle(v[0], v[1], v[5]);
        this.addTriangle(v[0], v[5], v[4]);
        // Back face (y2)
        this.addTriangle(v[2], v[3], v[7]);
        this.addTriangle(v[2], v[7], v[6]);
        // Left face (x1)
        this.addTriangle(v[3], v[0], v[4]);
        this.addTriangle(v[3], v[4], v[7]);
        // Right face (x2)
        this.addTriangle(v[1], v[2], v[6]);
        this.addTriangle(v[1], v[6], v[5]);
    }

    addRotatedBox(cx, cy, width, length, height, angleRad) {
        const halfW = width / 2;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);

        const transform = (lx, ly, lz) => {
            const rx = lx * cos - ly * sin;
            const ry = lx * sin + ly * cos;
            return { x: cx + rx, y: cy + ry, z: lz };
        };

        const v = [
            transform(-halfW, 0, 0),        // 0
            transform(halfW, 0, 0),         // 1
            transform(halfW, length, 0),    // 2
            transform(-halfW, length, 0),   // 3
            transform(-halfW, 0, height),   // 4
            transform(halfW, 0, height),    // 5
            transform(halfW, length, height),// 6
            transform(-halfW, length, height)// 7
        ];

        // Bottom face (z=0)
        this.addTriangle(v[0], v[2], v[1]);
        this.addTriangle(v[0], v[3], v[2]);
        // Top face (z=height)
        this.addTriangle(v[4], v[5], v[6]);
        this.addTriangle(v[4], v[6], v[7]);
        // Front face (y=0)
        this.addTriangle(v[0], v[1], v[5]);
        this.addTriangle(v[0], v[5], v[4]);
        // Back face (y=length)
        this.addTriangle(v[2], v[3], v[7]);
        this.addTriangle(v[2], v[7], v[6]);
        // Left face (x=-halfW)
        this.addTriangle(v[3], v[0], v[4]);
        this.addTriangle(v[3], v[4], v[7]);
        // Right face (x=halfW)
        this.addTriangle(v[1], v[2], v[6]);
        this.addTriangle(v[1], v[6], v[5]);
    }

    addCylinder(cx, cy, r, height, segments = 24) {
        const bottomVertices = [];
        const topVertices = [];
        for (let i = 0; i < segments; i++) {
            const angle = (2 * Math.PI * i) / segments;
            const x = cx + r * Math.cos(angle);
            const y = cy + r * Math.sin(angle);
            bottomVertices.push({ x, y, z: 0 });
            topVertices.push({ x, y, z: height });
        }

        const centerBottom = { x: cx, y: cy, z: 0 };
        const centerTop = { x: cx, y: cy, z: height };

        for (let i = 0; i < segments; i++) {
            const next = (i + 1) % segments;
            // Bottom face (pointing down)
            this.addTriangle(bottomVertices[i], centerBottom, bottomVertices[next]);
            // Top face (pointing up)
            this.addTriangle(topVertices[i], topVertices[next], centerTop);
            // Sides (pointing outwards)
            this.addTriangle(bottomVertices[i], topVertices[next], topVertices[i]);
            this.addTriangle(bottomVertices[i], bottomVertices[next], topVertices[next]);
        }
    }

    getString() {
        let s = `solid ${this.name}\n`;
        for (const t of this.triangles) {
            s += `  facet normal ${t.normal.x.toFixed(6)} ${t.normal.y.toFixed(6)} ${t.normal.z.toFixed(6)}\n`;
            s += `    outer loop\n`;
            s += `      vertex ${t.p1.x.toFixed(6)} ${t.p1.y.toFixed(6)} ${t.p1.z.toFixed(6)}\n`;
            s += `      vertex ${t.p2.x.toFixed(6)} ${t.p2.y.toFixed(6)} ${t.p2.z.toFixed(6)}\n`;
            s += `      vertex ${t.p3.x.toFixed(6)} ${t.p3.y.toFixed(6)} ${t.p3.z.toFixed(6)}\n`;
            s += `    endloop\n`;
            s += `  endfacet\n`;
        }
        s += `endsolid ${this.name}\n`;
        return s;
    }
}

const HangerGenerator = {
    /**
     * Generuje plik STL dla symetrycznego uchwytu ściennego Y
     * @param {Object} gridConfig - konfiguracja siatki (rozmiar heksa, gap, orientacja)
     * @param {Object} hangerConfig - parametry uchwytu (clearance, baseThickness, ridgeHeight, armLength, armWidth)
     * @returns {string} - Zawartość pliku STL (ASCII)
     */
    generateSTL(gridConfig, hangerConfig) {
        const hexSize = gridConfig.hexSize || 100;
        const gap = gridConfig.gap || 0;
        
        // Parametry uchwytu z domyślnymi wartościami bezpieczeństwa
        const clearance = parseFloat(hangerConfig.clearance !== undefined ? hangerConfig.clearance : 0.3);
        const baseThickness = parseFloat(hangerConfig.baseThickness !== undefined ? hangerConfig.baseThickness : 1.2);
        const ridgeHeight = parseFloat(hangerConfig.ridgeHeight !== undefined ? hangerConfig.ridgeHeight : 2.0);
        
        const configuredArmLength = parseFloat(hangerConfig.armLength !== undefined ? hangerConfig.armLength : 30);
        const configuredArmWidth = parseFloat(hangerConfig.armWidth !== undefined ? hangerConfig.armWidth : 12);
        
        // Zabezpieczenie przed zbyt małymi heksami - ramiona nie mogą wykraczać poza obrys heksa
        const maxArmLength = hexSize * 0.95;
        const armLength = Math.min(configuredArmLength, maxArmLength);
        const armWidth = Math.min(configuredArmWidth, hexSize * 0.8);
        const centerRadius = armWidth / 2;

        const writer = new STLWriter("symmetric_y_hanger");

        // Ramiona rozchodzą się pod kątami 90, 210, 330 stopni (symetryczna litera Y)
        const armAngles = [90, 210, 330];
        const degToRad = (deg) => (deg * Math.PI) / 180;

        // --- 1. RYSOWANIE BAZY (BASE PLATE) ---
        // Cylinder centralny łączący ramiona
        writer.addCylinder(0, 0, centerRadius, baseThickness);

        // Trzy płaskie ramiona (baza pod heksy i pasek montażowy)
        armAngles.forEach(deg => {
            const rad = degToRad(deg);
            // Rotacja o rad - Math.PI / 2, ponieważ domyślne ramiona addRotatedBox biegną wzdłuż osi Y
            writer.addRotatedBox(0, 0, armWidth, armLength, baseThickness, rad - Math.PI / 2);
        });

        // --- 2. RYSOWANIE SEPARATORÓW (RIDGES) ---
        // Szerokość separatora dopasowana do szczeliny dylatacyjnej
        const ridgeWidth = Math.max(0, gap - clearance);

        if (ridgeWidth > 0 && ridgeHeight > 0) {
            armAngles.forEach(deg => {
                const rad = degToRad(deg);
                // Ridge jest boxem o wysokości (baseThickness + ridgeHeight) nakładającym się od z=0
                writer.addRotatedBox(0, 0, ridgeWidth, armLength, baseThickness + ridgeHeight, rad - Math.PI / 2);
            });
        }

        return writer.getString();
    }
};

export default HangerGenerator;
