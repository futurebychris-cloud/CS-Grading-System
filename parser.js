// =============================================================================
// UNIVERSAL GRADEBOOK PARSER (JavaScript port of csv_reader.rb)
//
// Always organizes the output by OUTCOME (category) with per-assignment
// subcolumns underneath — regardless of whether the source CSV used the
// Individual or Collective layout.
//
// Exposes:
//   window.parseGradebook(csvText)
//   window.GRADER.computeWeightedFinals(view, weights)
//   window.GRADER.POINTS
// =============================================================================

(function () {
  const CATEGORY_PATTERN         = /^[A-Z]{1,4}$/i;
  const COMPOUND_PATTERN         = /^([A-Z]{1,4})(\d+)$/i;
  const ASSIGNMENT_TITLE_PATTERN = /assignment\s*#?\s*\d+/i;
  const STUDENT_PATTERN          = /^S\d+$/i;
  const GRADE_PATTERN            = /^(D|A|P|NY|NE|E|C|B|F)$/i;
  const POINTS = { A: 4, P: 3, D: 2, NY: 1 };

  const present = (v) => v != null && String(v).trim() !== '';
  const isCategoryCell = (v) =>
    present(v) && CATEGORY_PATTERN.test(v.trim()) && !COMPOUND_PATTERN.test(v.trim());
  const isCompoundCell    = (v) => present(v) && COMPOUND_PATTERN.test(v.trim());
  const isStudentCell     = (v) => present(v) && STUDENT_PATTERN.test(v.trim());
  const isAssignmentTitle = (v) => present(v) && ASSIGNMENT_TITLE_PATTERN.test(v.trim());
  const isGradeValue      = (v) => present(v) && GRADE_PATTERN.test(v.trim());

  // ---- CSV parsing ----------------------------------------------------------
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

  function detectLayout(rows) {
    for (const row of rows) {
      for (const cell of row) {
        if (isCompoundCell(cell)) return 'collective';
        if (isAssignmentTitle(cell)) return 'individual';
      }
    }
    return 'unknown';
  }

  // ---- Layout A: Individual -------------------------------------------------
  function parseIndividual(rows) {
    const records = [];
    const headerIndices = [];
    rows.forEach((r, i) => { if (r.some(isAssignmentTitle)) headerIndices.push(i); });

    headerIndices.forEach((headerIdx) => {
      const headerRow = rows[headerIdx];
      const colMap = {};
      let currentAssignment = null;
      headerRow.forEach((cell, col) => {
        if (isAssignmentTitle(cell)) currentAssignment = cell.trim();
        else if (isCategoryCell(cell) && currentAssignment) {
          colMap[col] = { assignment: currentAssignment, category: cell.trim().toUpperCase() };
        }
      });
      if (Object.keys(colMap).length === 0) return;

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

  // ---- Layout B: Collective -------------------------------------------------
  function parseCollective(rows) {
    const records = [];
    const headerIdx = rows.findIndex((r) => r.some(isCompoundCell));
    if (headerIdx === -1) return records;

    const headerRow = rows[headerIdx];
    const colMap = {};
    headerRow.forEach((cell, col) => {
      if (!isCompoundCell(cell)) return;
      const m = cell.trim().match(COMPOUND_PATTERN);
      colMap[col] = { assignment: cell.trim(), category: m[1].toUpperCase() };
    });

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const dataRow = rows[r];
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

  // ---- Unified outcome-first view ------------------------------------------
  // groups   : [{ label: <CATEGORY>, subcols: [<assignment label>] }]
  // students : ordered list of student ids (S2 < S10)
  // grades   : { sid: { categoryLabel: { assignmentLabel: grade } } }
  function buildView(layout, records) {
    const groups = [];
    const groupIdx = {};
    const students = [];
    const studentSeen = {};
    const grades = {};

    records.forEach((rec) => {
      const groupLabel  = rec.category;     // ALWAYS group by outcome
      const subcolLabel = rec.assignment;   // sub-column is the assignment

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

    // Sort subcols within each group by the numeric part of the label.
    // Works for both "ASSIGNMENT #3" and "D3".
    groups.forEach((g) => {
      g.subcols.sort((a, b) => {
        const na = parseInt((a.match(/(\d+)/) || ['0'])[1], 10);
        const nb = parseInt((b.match(/(\d+)/) || ['0'])[1], 10);
        return na - nb;
      });
      delete g._seen;
    });

    students.sort((a, b) => {
      const na = parseInt((a.match(/\d+/) || ['0'])[0], 10);
      const nb = parseInt((b.match(/\d+/) || ['0'])[0], 10);
      return na - nb;
    });

    return { layout, groups, students, grades };
  }

  // ---- Grade scales ---------------------------------------------------------
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

  // Per-student per-outcome average (point scale 0–4). Empty outcomes return null.
  function outcomeAverages(view, sid) {
    const out = {};
    view.groups.forEach((g) => {
      let total = 0, n = 0;
      g.subcols.forEach((sub) => {
        const v = view.grades[sid] && view.grades[sid][g.label] && view.grades[sid][g.label][sub];
        if (v && POINTS[v] != null) { total += POINTS[v]; n++; }
      });
      out[g.label] = n > 0 ? total / n : null;
    });
    return out;
  }

  // Simple (unweighted) final — kept for backwards compatibility.
  function computeFinals(view) {
    const finals = {};
    view.students.forEach((sid) => {
      let total = 0, n = 0;
      view.groups.forEach((g) => g.subcols.forEach((sub) => {
        const v = view.grades[sid] && view.grades[sid][g.label] && view.grades[sid][g.label][sub];
        if (v && POINTS[v] != null) { total += POINTS[v]; n++; }
      }));
      finals[sid] = { letter: n ? finalLetter(total / n) : '', score: n ? total / n : null };
    });
    return finals;
  }

  // Weighted final: average per outcome, then weighted average across outcomes.
  // weights: { categoryLabel: number }. Missing/0 weights drop the outcome from
  // the calculation. Outcomes the student has no grades for are also skipped.
  function computeWeightedFinals(view, weights) {
    const finals = {};
    view.students.forEach((sid) => {
      const avgs = outcomeAverages(view, sid);
      let weightedSum = 0, weightSum = 0;
      view.groups.forEach((g) => {
        const w = weights && weights[g.label] != null ? Number(weights[g.label]) : 1;
        if (!(w > 0)) return;
        if (avgs[g.label] == null) return;
        weightedSum += avgs[g.label] * w;
        weightSum  += w;
      });
      const score = weightSum > 0 ? weightedSum / weightSum : null;
      finals[sid] = {
        letter: score !== null ? finalLetter(score) : '',
        score,
        outcomeAvgs: avgs,
      };
    });
    return finals;
  }

  function parseGradebook(csvText) {
    const rows = parseCSV(csvText);
    const { layout, records } = extractRecords(rows);
    const view = buildView(layout, records);
    const finals = computeFinals(view);
    return Object.assign({}, view, { finals, records, POINTS });
  }

  const api = { parseGradebook, computeFinals, computeWeightedFinals, outcomeAverages, POINTS };

  if (typeof window !== 'undefined') {
    window.parseGradebook = parseGradebook;
    window.GRADER = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
