import {
  DEFAULT_SECTION,
  EXPORT_FORMATS,
  OPEN_STATUSES,
  OPTIONAL_MODULES,
  REC_DOMAINS,
  SCAN_SCOPES,
  SCORE_METHOD,
  SECTIONS,
  buildXlsx,
  componentTypeLabel,
  copyText,
  downloadBinary,
  downloadText,
  exportFileName,
  exportRows,
  findSection,
  formatDate,
  formatDateTime,
  formatDuration,
  formatExportDate,
  formatNumber,
  formatRelative,
  initials,
  isScanInProgress,
  pluralize,
  recStatusTone,
  reduceErrors,
  scanStatusTone,
  scoreBand,
  sectionsFor,
  severityIcon,
  severityMeta,
  toCsv,
  todayIso
} from "c/orgIntelUtils";

// jsdom ne fournit pas TextEncoder / TextDecoder (présents dans tous les navigateurs)
const {
  TextEncoder: NodeTextEncoder,
  TextDecoder: NodeTextDecoder
} = require("util");
global.TextEncoder = global.TextEncoder || NodeTextEncoder;
global.TextDecoder = global.TextDecoder || NodeTextDecoder;

/** Lit les entrées d'une archive zip « stored » : { nom: texte }. */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files = {};
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const name = decoder.decode(
      bytes.subarray(offset + 30, offset + 30 + nameLength)
    );
    const start = offset + 30 + nameLength;
    files[name] = decoder.decode(bytes.subarray(start, start + size));
    offset = start + size;
  }
  return { files, centralOffset: offset, view };
}

/** Intercepte le lien de téléchargement créé puis cliqué. */
function captureDownload() {
  const links = [];
  const spy = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function click() {
      links.push({ href: this.href, download: this.download });
    });
  return { links, restore: () => spy.mockRestore() };
}

const COLUMNS = [
  { label: "Name", value: (row) => row.name },
  { label: "Count", value: (row) => row.count },
  { label: "Active", value: (row) => row.active }
];

describe("c-org-intel-utils", () => {
  describe("sections", () => {
    it("lists the sections of the navigation", () => {
      expect(SECTIONS.every((section) => section.available)).toBe(true);
      expect(
        SECTIONS.filter((section) => section.adminOnly).map(
          (section) => section.name
        )
      ).toEqual([
        "fieldUsage",
        "objectSetup",
        "security",
        "permissions",
        "inventory",
        "adoption",
        "apiMonitoring",
        "modules",
        "settings"
      ]);
      expect(DEFAULT_SECTION).toBe("overview");
      expect(findSection("scanner").label).toBe("Org Scanner");
      expect(findSection("scanner").hidden).toBe(true);
      expect(findSection("unknown")).toBeUndefined();
    });

    it("hides the sections of the modules that are not installed", () => {
      const core = sectionsFor().map((section) => section.name);
      expect(core).toContain("overview");
      expect(core).toContain("settings");
      expect(core).not.toContain("fieldUsage");
      expect(core).not.toContain("security");
      expect(
        SECTIONS.filter((section) => section.module).every(
          (section) => !core.includes(section.name)
        )
      ).toBe(true);

      const withFieldUsage = sectionsFor(["fieldUsage"]).map(
        (section) => section.name
      );
      expect(withFieldUsage).toEqual(
        expect.arrayContaining(["fieldUsage", "objectSetup"])
      );
      expect(withFieldUsage).not.toContain("security");
    });

    it("describes every optional module with a known section", () => {
      const keys = OPTIONAL_MODULES.map((module) => module.key);
      expect(new Set(keys).size).toBe(keys.length);
      OPTIONAL_MODULES.forEach((module) => {
        expect(findSection(module.section)).toBeDefined();
        expect(typeof module.packageVersionId).toBe("string");
        expect(Array.isArray(module.objects)).toBe(true);
      });
    });
  });

  describe("reference values", () => {
    it("maps severities to tones and keeps unknown values readable", () => {
      expect(severityMeta("Critical").tone).toBe("critical");
      expect(severityMeta("Info").points).toBe(0);
      expect(severityMeta(undefined).label).toBe("Unknown");
      expect(severityMeta("Odd").label).toBe("Odd");
      expect(SCORE_METHOD.weights[0]).toEqual({
        label: "Critical",
        points: 10
      });
    });

    it("maps statuses, component types and icons", () => {
      expect(scanStatusTone("Completed")).toBe("good");
      expect(scanStatusTone("Failed")).toBe("critical");
      expect(scanStatusTone("Other")).toBe("neutral");
      expect(componentTypeLabel("ApexClass")).toBe("Apex class");
      expect(componentTypeLabel("Unknown")).toBe("Unknown");
      expect(componentTypeLabel(undefined)).toBe("");
      expect(severityIcon("Critical")).toBe("utility:error");
      expect(severityIcon("High")).toBe("utility:error");
      expect(severityIcon("Medium")).toBe("utility:warning");
      expect(severityIcon("Low")).toBe("utility:info");
      expect(isScanInProgress("Queued")).toBe(true);
      expect(isScanInProgress("Running")).toBe(true);
      expect(isScanInProgress("Completed")).toBe(false);
      expect(recStatusTone("Resolved")).toBe("good");
      expect(recStatusTone("Nope")).toBe("neutral");
      expect(OPEN_STATUSES).toEqual(["New", "To Review", "Accepted"]);
      expect(SCAN_SCOPES.filter((scope) => scope.tooling)).toHaveLength(2);
      expect(REC_DOMAINS[REC_DOMAINS.length - 1].value).toBe("Other");
      expect(EXPORT_FORMATS.map((format) => format.value)).toEqual([
        "xlsx",
        "csv"
      ]);
    });

    it("reads the score in documented bands", () => {
      expect(scoreBand(null).label).toBe("Not available");
      expect(scoreBand(undefined).label).toBe("Not available");
      expect(scoreBand(92).label).toBe("Healthy");
      expect(scoreBand(85).label).toBe("Healthy");
      expect(scoreBand(70).label).toBe("Fair");
      expect(scoreBand(50).label).toBe("Needs attention");
      expect(scoreBand(12).label).toBe("At risk");
      expect(scoreBand(0).tone).toBe("critical");
    });
  });

  describe("formatting", () => {
    it("formats numbers, durations and relative dates", () => {
      expect(formatNumber(null)).toBe("—");
      expect(formatNumber("abc")).toBe("—");
      expect(formatNumber(82.5)).toBe("82.5");
      expect(formatNumber(1284)).toBe("1,284");
      expect(formatNumber(12900)).toBe("12.9K");
      expect(
        formatDuration("2026-10-15T10:00:00Z", "2026-10-15T10:02:14Z")
      ).toBe("2 min 14 s");
      expect(
        formatDuration("2026-10-15T10:00:00Z", "2026-10-15T10:00:45Z")
      ).toBe("45 s");
      expect(
        formatDuration("2026-10-15T10:00:00Z", "2026-10-15T12:05:00Z")
      ).toBe("2 h 5 min");
      expect(
        formatDuration("2026-10-15T10:00:00Z", "2026-10-15T09:00:00Z")
      ).toBe("0 s");
      expect(formatDuration("2026-10-15T10:00:00Z", null)).toBeNull();

      const now = new Date("2026-10-15T12:00:00Z");
      expect(formatRelative("2026-10-15T11:59:40Z", now)).toBe("just now");
      expect(formatRelative("2026-10-15T09:00:00Z", now)).toBe("3 hours ago");
      expect(formatRelative("2026-10-14T12:00:00Z", now)).toBe("yesterday");
      expect(formatRelative("2026-10-15T12:10:00Z", now)).toBe("in 10 minutes");
      expect(formatRelative(null, now)).toBe("—");
    });

    it("formats dates, initials and plurals", () => {
      expect(formatDate(null)).toBe("—");
      expect(formatDate("2026-10-15")).toBe("15 Oct 2026");
      expect(formatDate(new Date(2026, 9, 15, 12))).toBe("15 Oct 2026");
      expect(formatDateTime(null)).toBe("—");
      expect(formatDateTime(new Date(2026, 9, 15, 9, 5))).toContain(
        "15 Oct 2026"
      );
      expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
      expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(initials("Ada Lovelace King")).toBe("AL");
      expect(initials("  marie ")).toBe("M");
      expect(initials(null)).toBe("?");
      expect(pluralize(1, "finding")).toBe("1 finding");
      expect(pluralize(3, "finding")).toBe("3 findings");
      expect(pluralize(2, "entry", "entries")).toBe("2 entries");
    });

    it("formats export dates in local time", () => {
      expect(formatExportDate(null)).toBe("");
      expect(formatExportDate("2026-03-07")).toBe("2026-03-07 00:00");
      expect(formatExportDate("2026-03-07", false)).toBe("2026-03-07");
      expect(formatExportDate(new Date(2026, 2, 7, 9, 4))).toBe(
        "2026-03-07 09:04"
      );
      expect(formatExportDate("not a date")).toBe("not a date");
    });
  });

  describe("errors", () => {
    it("reduces Apex, LDS and JavaScript errors to a readable message", () => {
      expect(reduceErrors({ body: { message: "Access denied" } })).toBe(
        "Access denied"
      );
      expect(reduceErrors({ body: [{ message: "A" }, { message: "B" }] })).toBe(
        "A B"
      );
      expect(
        reduceErrors({ body: { pageErrors: [{ message: "Page error" }] } })
      ).toBe("Page error");
      expect(reduceErrors(new Error("Boom"))).toBe("Boom");
      expect(reduceErrors("Plain text")).toBe("Plain text");
      expect(reduceErrors({ statusText: "Bad Request" })).toBe("Bad Request");
      expect(reduceErrors({})).toBe("Unknown error");
      expect(reduceErrors(["Same", "Same", null])).toBe("Same");
      expect(reduceErrors(undefined)).toBe("Unknown error");
    });
  });

  describe("CSV and downloads", () => {
    it("builds a CSV with semicolons and escapes special characters", () => {
      const csv = toCsv(
        [
          { name: 'Say "hi"', count: 2, active: true },
          { name: "a;b", count: null, active: false },
          { name: "line\nbreak", count: 0, active: undefined }
        ],
        COLUMNS
      );
      expect(csv.split("\r\n")).toEqual([
        "Name;Count;Active",
        '"Say ""hi""";2;true',
        '"a;b";;false',
        '"line\nbreak";0;'
      ]);
    });

    it("downloads text through a data URL and removes the link", () => {
      const capture = captureDownload();
      downloadText("notes.md", "# Title & more", "text/markdown");
      capture.restore();
      expect(capture.links).toHaveLength(1);
      expect(capture.links[0].download).toBe("notes.md");
      expect(capture.links[0].href).toBe(
        `data:text/markdown;charset=utf-8,${encodeURIComponent("# Title & more")}`
      );
      expect(document.body.children).toHaveLength(0);
    });

    it("downloads binary content as base64", () => {
      const capture = captureDownload();
      downloadBinary("file.bin", new Uint8Array([72, 105]), "application/x");
      capture.restore();
      expect(capture.links[0].href).toBe("data:application/x;base64,SGk=");
      expect(capture.links[0].download).toBe("file.bin");
    });

    it("names export files with a slug and the date", () => {
      const today = todayIso();
      expect(exportFileName("Récap Sécurité / 2026", "csv")).toBe(
        `org-intelligence-recap-securite-2026-${today}.csv`
      );
      expect(exportFileName(null, "xlsx")).toBe(
        `org-intelligence-export-${today}.xlsx`
      );
    });

    it("copies with the clipboard API, then with the fallback", async () => {
      const writeText = jest.fn(() => Promise.resolve());
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true
      });
      await expect(copyText("hello")).resolves.toBe(true);
      expect(writeText).toHaveBeenCalledWith("hello");

      writeText.mockImplementation(() => Promise.reject(new Error("denied")));
      document.execCommand = jest.fn(() => true);
      await expect(copyText("again")).resolves.toBe(true);
      expect(document.execCommand).toHaveBeenCalledWith("copy");
      expect(document.body.children).toHaveLength(0);

      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        configurable: true
      });
      document.execCommand = jest.fn(() => {
        throw new Error("unsupported");
      });
      await expect(copyText("nope")).resolves.toBe(false);
      delete document.execCommand;
    });
  });

  describe("Excel export", () => {
    it("builds a valid stored zip with one worksheet per sheet", () => {
      const bytes = buildXlsx([
        {
          name: "Findings: [all]",
          columns: COLUMNS,
          rows: [
            { name: "A & <B>", count: 12, active: true },
            { name: "", count: null, active: false }
          ]
        },
        { name: "", columns: [], rows: [] }
      ]);
      const { files, centralOffset, view } = readZip(bytes);
      expect(Object.keys(files)).toEqual([
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/sheet2.xml"
      ]);
      // Répertoire central puis fin d'archive avec le bon nombre d'entrées
      expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
      const end = bytes.length - 22;
      expect(view.getUint32(end, true)).toBe(0x06054b50);
      expect(view.getUint16(end + 10, true)).toBe(7);
      expect(view.getUint32(end + 16, true)).toBe(centralOffset);

      // Noms de feuilles nettoyés (caractères interdits), feuille sans nom numérotée
      expect(files["xl/workbook.xml"]).toContain('name="Findings   all"');
      expect(files["xl/workbook.xml"]).toContain('name="Sheet2"');
      expect(files["[Content_Types].xml"]).toContain(
        "/xl/worksheets/sheet2.xml"
      );

      const sheet = files["xl/worksheets/sheet1.xml"];
      expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t>Name</t>');
      expect(sheet).toContain("A &amp; &lt;B&gt;");
      expect(sheet).toContain('<c r="B2"><v>12</v></c>');
      expect(sheet).toContain(">Yes</t>");
      expect(sheet).toContain(">No</t>");
      expect(sheet).toContain('<autoFilter ref="A1:C3"/>');
      expect(sheet).toContain('state="frozen"');
      expect(files["xl/worksheets/sheet2.xml"]).toContain(
        '<autoFilter ref="A1:A1"/>'
      );
    });

    it("computes column letters beyond Z and truncates long texts", () => {
      const columns = Array.from({ length: 28 }, (_, index) => ({
        label: `C${index}`,
        value: (row) => (index === 27 ? row.text : index)
      }));
      const bytes = buildXlsx([
        { name: "Wide", columns, rows: [{ text: "x".repeat(40000) }] }
      ]);
      const sheet = readZip(bytes).files["xl/worksheets/sheet1.xml"];
      expect(sheet).toContain('<c r="AB1"');
      expect(sheet).toContain('<autoFilter ref="A1:AB2"/>');
      expect(sheet).toContain(`>${"x".repeat(32000)}</t>`);
      expect(sheet).not.toContain("x".repeat(32001));
      expect(sheet).toContain('width="60"');
    });

    it("exports rows as Excel or CSV", () => {
      const capture = captureDownload();
      const rows = [{ name: "Alpha", count: 1, active: true }];
      exportRows({ name: "Recommendations", columns: COLUMNS, rows });
      exportRows({
        name: "Recommendations",
        format: "csv",
        columns: COLUMNS,
        rows
      });
      exportRows({
        name: "Multi",
        format: "csv",
        sheets: [
          { name: "First", columns: COLUMNS.slice(0, 1), rows },
          { name: "Second", columns: COLUMNS, rows }
        ]
      });
      exportRows({ name: "Empty", format: "csv" });
      capture.restore();

      const [xlsx, csv, multi, empty] = capture.links;
      expect(xlsx.download).toMatch(
        /^org-intelligence-recommendations-.*\.xlsx$/
      );
      expect(xlsx.href).toMatch(
        /^data:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet;base64,UEsDB/
      );
      expect(csv.download).toMatch(/\.csv$/);
      const csvText = decodeURIComponent(
        csv.href.split(",").slice(1).join(",")
      );
      expect(csvText).toBe("﻿Name;Count;Active\r\nAlpha;1;true");
      expect(decodeURIComponent(multi.href.split(",").slice(1).join(","))).toBe(
        "﻿Name\r\nAlpha"
      );
      expect(decodeURIComponent(empty.href.split(",").slice(1).join(","))).toBe(
        "﻿"
      );
    });
  });
});
