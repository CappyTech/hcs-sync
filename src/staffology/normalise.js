/**
 * Pure mapping from Staffology API payloads to the hcs-schemas payroll
 * entities (payrollEmployee, payrollPayRunEntry). No I/O, so it is tested
 * directly.
 *
 * Deliberately dropped: NI number, date of birth, address, bank details. The
 * comparison in hcs-app matches on payroll code and needs none of them.
 */
export const SOURCE = 'staffology';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const str = (v) => (v == null || v === '' ? null : String(v));

/** 'Year2026' → 2026 (the tax year 2026/27). */
export function parseTaxYear(v) {
  const m = /^Year(\d{4})$/.exec(String(v || ''));
  return m ? Number(m[1]) : num(v);
}

/** 2026 → 'Year2026'. */
export const taxYearKey = (year) => `Year${year}`;

/** The tax year (start year) a date falls in: 6 April starts a new one. */
export function taxYearOf(d = new Date()) {
  const y = d.getUTCFullYear();
  const startsThisYear = d.getUTCMonth() > 3 || (d.getUTCMonth() === 3 && d.getUTCDate() >= 6);
  return startsThisYear ? y : y - 1;
}

/**
 * A pay run list Item to { period, ordinal }. The list returns Items whose url
 * ends in the period number (…/payrun/Year2026/Weekly/12, maybe ?ordinal=2);
 * metadata is checked first in case it carries them.
 */
export function payRunRef(item) {
  const meta = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  let period = num(meta.period ?? meta.periodNumber);
  let ordinal = num(meta.ordinal);
  const url = String(item?.url || '');
  if (period == null) {
    const m = /\/payrun\/[^/]+\/[^/]+\/(\d+)(?:[/?]|$)/i.exec(url);
    if (m) period = Number(m[1]);
  }
  if (ordinal == null) {
    const m = /[?&]ordinal=(\d+)/i.exec(url);
    ordinal = m ? Number(m[1]) : 1;
  }
  return period == null ? null : { period, ordinal };
}

const fullName = (pd) => [pd?.firstName, pd?.lastName].filter(Boolean).join(' ') || null;

export function normaliseEmployee(emp, { employerId, listItem, now = new Date() } = {}) {
  const pd = emp?.personalDetails || {};
  const ed = emp?.employmentDetails || {};
  const po = emp?.payOptions || {};
  return {
    Source: SOURCE,
    ExternalId: String(emp?.id || listItem?.id),
    EmployerId: str(employerId),
    PayrollCode: str(ed.payrollCode ?? listItem?.metadata?.payrollCode),
    FirstName: str(pd.firstName),
    LastName: str(pd.lastName),
    Status: str(emp?.status),
    JobTitle: str(ed.jobTitle),
    PayBasis: str(po.basis),
    PayPeriod: str(po.period),
    BaseHourlyRate: num(po.baseHourlyRate),
    BaseDailyRate: num(po.baseDailyRate),
    PayAmount: num(po.payAmount),
    StartDate: date(ed.starterDetails?.startDate),
    LeaveDate: date(ed.leaverDetails?.leaveDate),
    SyncedAt: now,
  };
}

export function normaliseTotals(t = {}) {
  return {
    Gross: num(t.gross),
    BasicPay: num(t.basicPay),
    Additions: num(t.additions),
    Deductions: num(t.deductions),
    Tax: num(t.tax),
    EmployeeNi: num(t.employeeNi),
    EmployerNi: num(t.employerNi),
    EmployeePension: num(t.employeePensionContribution),
    EmployerPension: num(t.employerPensionContribution),
    NetPay: num(t.netPay),
    TakeHomePay: num(t.takeHomePay),
    TotalCost: num(t.totalCost),
  };
}

export function normalisePayLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((l) => ({
    Code: str(l?.code),
    Description: str(l?.description),
    Value: num(l?.value),
    Rate: num(l?.rate),
    Multiplier: num(l?.multiplier),
  }));
}

/**
 * One pay run entry. `run` supplies what the entry may omit (tax year, period,
 * dates, closed state) and `item` is the entry's Item from run.entries.
 */
export function normalisePayRunEntry(entry, { employerId, run = {}, item, now = new Date() } = {}) {
  const ed = entry?.employmentDetails || {};
  const po = entry?.payOptions || {};
  return {
    Source: SOURCE,
    ExternalId: String(entry?.id || item?.id),
    EmployerId: str(employerId),
    EmployeeExternalId: str(entry?.employee?.id),
    PayrollCode: str(ed.payrollCode ?? entry?.employee?.metadata?.payrollCode ?? item?.metadata?.payrollCode),
    EmployeeName: str(entry?.employee?.name) || fullName(entry?.personalDetails) || str(item?.name),
    TaxYear: parseTaxYear(entry?.taxYear ?? run.taxYear),
    PayPeriod: str(entry?.payPeriod ?? run.payPeriod),
    Period: num(entry?.period ?? run.period),
    Ordinal: num(entry?.ordinal ?? run.ordinal) ?? 1,
    StartDate: date(entry?.startDate ?? run.startDate),
    EndDate: date(entry?.endDate ?? run.endDate),
    PaymentDate: date(entry?.paymentDate ?? run.paymentDate),
    IsClosed: Boolean(entry?.isClosed ?? run.isClosed),
    // The basic pay options of this entry: the rate actually paid this period,
    // which may differ from the employee's current rate.
    PayBasis: str(po.basis),
    BaseHourlyRate: num(po.baseHourlyRate),
    BaseDailyRate: num(po.baseDailyRate),
    PayAmount: num(po.payAmount),
    PayAmountMultiplier: num(po.payAmountMultiplier),
    Totals: normaliseTotals(entry?.totals),
    PayLines: normalisePayLines(po.regularPayLines),
    SyncedAt: now,
  };
}
