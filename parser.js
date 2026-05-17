// =============================================================================
// UNIVERSAL GRADEBOOK PARSER (JavaScript port of csv_reader.rb)
//
// Supports two CSV layouts:
//
// Layout A — Individual Assessment
//   Row N:   ASSIGNMENT #1 | D | Ab | Eg |  | ASSIGNMENT #2 | D | Eg | ...
//   Row N+1: S1            | D | A  | A  |  | S1            | A | A  | ...
//
// Layout B — Collective Assessment
//   Row N:   (blank) | D1 | D2 | D3 |  | C1 | C2 |  | Eg1 | ...
//   Row N+1: S1      | D  | A  | A  |  | A  | A  |  | A   | ...
//
// Exposes window.parseGradebook(csvText) returning a unified view object.
// =============================================================================

(function (root) {
  // ---------------------------------------------------------------------------
  // PATTERNS
  // ---------------------------------------------------------------------------
  const CATEGORY_PATTERN         = /^[A-Z]{1,4}$/i;          // D, Ab, Eg, CT
  const COMPOUND_PATTERN         = /^([A-Z]{1,4})(\d+)$/i;   // D1, Ab2, Eg10
  const ASSIGNMENT_TITLE_PATTERN = /assignment\s*#?\s*\d+/i; // "ASSIGNMENT #1"
  const STUDENT_PATTERN          = /^S\d+$/i;                // S1, S001
  const GRADE_PATTERN            = /^(D|A|P|NY|NE|E|C|B|F)$/i;

  // Points used for the final grade average. Matches the original HTML.
  const POINTS = { A: 4, P: 3, D: 2, NY: 1 };

  // ---------------------------------------------------------------------------
  // CELL HELPERS
  // ---------------------------------------------------------------------------
  const present = (v) => v != null && String(v).trim() !== '';
  const isCategoryCell = (v) =>
    present(v) && CATEGORY_PATTERN.test(v.trim()) && !COMPOUND_PATTERN.test(v.trim());
  const isCompoundCell      = (v) => present(v) && COMPOUND_PATTERN.test(v.trim());
  const isStudentCell       = (v) => present(v) && STUDENT_PATTERN.test(v.trim());
  const isAssignmentTitle   = (v) => present(v) && ASSIGNMENT_TITLE_PATTERN.test(v.trim());
  const isGradeValue        = (v) => present(v) && GRADE_PATTERN.test(v.trim());

  // ---------------------------------------------------------------------------
  // CSV PARSE (handles quoted fields, CRLF, trailing commas)
  // Empty cells become null after trim — matches the Ruby loader.
  // ---------------------------------------------------------------------------
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else { field += c; }
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
          if (c === '\r' && text[i + 1] === '\n') i++;
          row.push(field); rows.push(row); row = []; field = '';
        } else { field += c; }
      }
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows.map((r) =>
      r.map((cell) => {
        const s = String(cell).trim();
        return s === '' ? null : s;
      })
    );
  }

  // ---------------------------------------------------------------------------
  // LAYOUT DETECTION
  // Collective wins if compound headers (D1) appear anywhere.
  // ---------------------------------------------------------------------------
  function detectLayout(rows) {
    for (const row of rows) {
      for (const cell of row) {
        if (isCompoundCell(cell)) return 'collective';
        if (isAssignmentTitle(cell)) return 'individual';
      }
    }
    return 'unknown';
  }

  // ---------------------------------------------------------------------------
  // LAYOUT A — INDIVIDUAL ASSESSMENT
  // ---------------------------------------------------------------------------
  function parseIndividual(rows) {
    const records = [];

    const headerIndices = [];
    rows.forEach((r, i) => {
      if (r.some(isAssignmentTitle)) headerIndices.push(i);
    });

    headerIndices.forEach((headerIdx) => {
      const headerRow = rows[headerIdx];
      const colMap = {};        // col -> { assignment, category }
      let currentAssignment = null;

      headerRow.forEach((cell, col) => {
        if (isAssignmentTitle(cell)) {
          currentAssignment = cell.trim();
        } else if (isCategoryCell(cell) && currentAssignment) {
          colMap[col] = {
            assignment: currentAssignment,
            category: cell.trim().toUpperCase(),
          };
        }
      });

      if (Object.keys(colMap).length === 0) return;

      // Data rows run until the next header row (or EOF)
      let dataEnd = rows.length - 1;
      for (let r = headerIdx + 1; r < rows.length; r++) {
        if (rows[r].some(isAssignmentTitle)) { dataEnd = r - 1; break; }
      }

      for (let r = headerIdx + 1; r <= dataEnd; r++) {
        const dataRow = rows[r];
        for (const colStr of Object.keys(colMap)) {
          const col = parseInt(colStr, 10);
          const g = dataRow[col];
          if (!isGradeValue(g)) continue;

          // Find nearest student id to the left in this row
          let student = null;
          for (let c = col; c >= 0; c--) {
            if (isStudentCell(dataRow[c])) { student = dataRow[c].trim(); break; }
          }
          if (!student) continue;

          records.push({
            student,
            assignment: colMap[col].assignment,
            category:   colMap[col].category,
            grade:      g.trim().toUpperCase(),
          });
        }
      }
    });

    return records;
  }

  // ---------------------------------------------------------------------------
  // LAYOUT B — COLLECTIVE ASSESSMENT
  // ---------------------------------------------------------------------------
  function parseCollective(rows) {
    const records = [];

    const headerIdx = rows.findIndex((r) => r.some(isCompoundCell));
    if (headerIdx === -1) return records;

    const headerRow = rows[headerIdx];
    const colMap = {}; // col -> { assignment: "D1", category: "D" }
    headerRow.forEach((cell, col) => {
      if (!isCompoundCell(cell)) return;
      const m = cell.trim().match(COMPOUND_PATTERN);
      colMap[col] = { assignment: cell.trim(), category: m[1].toUpperCase() };
    });

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const dataRow = rows[r];

      // First student-shaped cell in the row wins (typically col 0)
      let student = null;
      for (const cell of dataRow) {
        if (isStudentCell(cell)) { student = cell.trim(); break; }
      }
      if (!student) continue;

      for (const colStr of Object.keys(colMap)) {
        const col = parseInt(colStr, 10);
        const g = dataRow[col];
        if (!isGradeValue(g)) continue;
        records.push({
          student,
          assignment: colMap[col].assignment,
          category:   colMap[col].category,
          grade:      g.trim().toUpperCase(),
        });
      }
    }

    return records;
  }

  function extractRecords(rows) {
    const layout = detectLayout(rows);
    if (layout === 'individual') return { layout, records: parseIndividual(rows) };
    if (layout === 'collective') return { layout, records: parseCollective(rows) };
    return { layout: 'unknown', records: [] };
  }

  // ---------------------------------------------------------------------------
  // UNIFIED VIEW
  //
  // groups   : [{ label, subcols: [string] }]
  //   - individual: label = "ASSIGNMENT #1", subcols = ["D","Ab","Eg"]
  //   - collective: label = "D" (category),   subcols = ["D1","D2","D3"]
  // students : ordered list of student ids
  // grades   : { sid: { groupLabel: { subcol: grade } } }
  // ---------------------------------------------------------------------------
  function buildView(layout, records) {
    const groups = [];
    const groupIdx = {};
    const students = [];
    const studentSeen = {};
    const grades = {};

    records.forEach((rec) => {
      const groupLabel  = layout === 'individual' ? rec.assignment : rec.category;
      const subcolLabel = layout === 'individual' ? rec.category   : rec.assignment;

      if (!(groupLabel in groupIdx)) {
        groupIdx[groupLabel] = groups.length;
        groups.push({ label: groupLabel, subcols: [], _seen: {} });
      }
      const g = groups[groupIdx[groupLabel]];
      if (!(subcolLabel in g._seen)) {
        g._seen[subcolLabel] = true;
        g.subcols.push(subcolLabel);
      }

      if (!(rec.student in studentSeen)) {
        studentSeen[rec.student] = true;
        students.push(rec.student);
      }

      grades[rec.student] = grades[rec.student] || {};
      grades[rec.student][groupLabel] = grades[rec.student][groupLabel] || {};
      grades[rec.student][groupLabel][subcolLabel] = rec.grade;
    });

    // Preserve CSV insertion order for subcols. Only re-sort compound headers
    // numerically within the same category (so D2 < D10 even if seen out of order).
    groups.forEach((g) => {
      const allCompound = g.subcols.every((s) => COMPOUND_PATTERN.test(s));
      if (allCompound) {
        g.subcols.sort((a, b) => {
          const ma = a.match(COMPOUND_PATTERN);
          const mb = b.match(COMPOUND_PATTERN);
          if (ma[1].toUpperCase() === mb[1].toUpperCase()) {
            return parseInt(ma[2], 10) - parseInt(mb[2], 10);
          }
          return ma[1].localeCompare(mb[1]);
        });
      }
      delete g._seen;
    });

    // Sort students by leading numeric portion (S2 < S10)
    students.sort((a, b) => {
      const na = parseInt((a.match(/\d+/) || ['0'])[0], 10);
      const nb = parseInt((b.match(/\d+/) || ['0'])[0], 10);
      return na - nb;
    });

    return { layout, groups, students, grades };
  }

  // ---------------------------------------------------------------------------
  // FINAL GRADE
  // ---------------------------------------------------------------------------
  function finalLetter(avg) {
    if (avg >= 3.9) return 'A+';
    if (avg >= 3.6) return 'A';
    if (avg >= 3.3) return 'A-';
    if (avg >= 3.0) return 'B+';
    if (avg >= 2.7) return 'B';
    if (avg >= 2.4) return 'B-';
    if (avg >= 2.1) return 'C+';
    if (avg >= 1.8) return 'C';
    if (avg >= 1.5) return 'C-';
    if (avg >= 1.3) return 'D+';
    if (avg >= 1.1) return 'D';
    return 'F';
  }

  function computeFinals(view) {
    const finals = {};
    view.students.forEach((sid) => {
      let total = 0, n = 0;
      view.groups.forEach((g) => {
        g.subcols.forEach((sub) => {
          const v = view.grades[sid] && view.grades[sid][g.label] && view.grades[sid][g.label][sub];
          if (v && POINTS[v] != null) { total += POINTS[v]; n++; }
        });
      });
      finals[sid] = { letter: n ? finalLetter(total / n) : '', score: n ? total / n : null };
    });
    return finals;
  }

  // ---------------------------------------------------------------------------
  // PUBLIC ENTRY
  // ---------------------------------------------------------------------------
  function parseGradebook(csvText) {
    const rows = parseCSV(csvText);
    const { layout, records } = extractRecords(rows);
    const view = buildView(layout, records);
    const finals = computeFinals(view);
    return Object.assign({}, view, { finals, records, POINTS });
  }

  const api = { parseGradebook, POINTS };

  // Browser
  if (typeof window !== 'undefined') {
    window.parseGradebook = parseGradebook;
    window.GRADER = api;
  }
  // Node (for tests)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
