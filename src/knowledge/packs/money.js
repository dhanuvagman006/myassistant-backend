/**
 * PACK: MONEY, TAX AND BANKING.
 *
 * A NOTE ON DATED FIGURES, WHICH MATTERS MORE HERE THAN ANYWHERE ELSE.
 * Tax slabs, limits and thresholds are revised in the Union Budget every
 * February. An entry stating a slab is therefore true OF A FINANCIAL YEAR,
 * not forever. Every such entry below names its financial year in the text
 * and carries `effective`, so the assistant says "for FY 2025-26" out loud
 * instead of implying it is timeless, and tells the user to confirm the
 * current year's figure.
 *
 * That is deliberate: a confidently stated stale slab is exactly the kind
 * of answer someone files a return on.
 *
 * Procedure and rights — how to recover a fraudulent UPI debit, what a bank
 * must do, how an insurance claim is escalated — change far more slowly and
 * are the more durable value of this pack.
 */

const DOMAIN = "money";

const e = (slug, source_short, source_title, ref, title, summary, detail, topics, source_url, effective = "") => ({
  slug: `MONEY:${slug}`,
  domain: DOMAIN,
  source_title,
  source_short,
  ref,
  title,
  summary,
  detail,
  topics: `money ${topics}`.trim(),
  replaces: "",
  source_url,
  status: "in_force",
  effective,
});

const ITD = "https://www.incometax.gov.in";
const RBI = "https://www.rbi.org.in";
const IRDAI = "https://www.irdai.gov.in";
const EPFO = "https://www.epfindia.gov.in";

const ENTRIES = [
  /* ---------------- INCOME TAX ---------------- */

  e("tax.regime", "Income Tax Department", "Income-tax Act, 1961", "Section 115BAC",
    "There are two regimes. The NEW regime is the default: lower slab rates but almost no deductions or exemptions. The OLD regime keeps deductions like 80C, 80D, HRA and home loan interest but taxes at higher rates.",
    "A salaried person may choose afresh each year when filing. Someone with business income may switch to the new regime only once and cannot go back freely. Rule of thumb: if your deductions (80C, 80D, HRA, home loan interest) are large, the old regime often still wins; if you claim little, the new regime usually does. Compare both on the department's own tax calculator rather than by rule of thumb.",
    "tax income regime deduction", `${ITD}`, "2023-04-01"),

  e("tax.slabs.newregime", "Income Tax Department", "Finance Act", "Slabs — FY 2025-26",
    "Under the NEW regime for FINANCIAL YEAR 2025-26 (assessment year 2026-27): nil up to ₹4 lakh; 5% from ₹4–8 lakh; 10% from ₹8–12 lakh; 15% from ₹12–16 lakh; 20% from ₹16–20 lakh; 25% from ₹20–24 lakh; 30% above ₹24 lakh.",
    "With the Section 87A rebate, income up to ₹12 LAKH carries no tax under the new regime — ₹12.75 lakh for a salaried person after the ₹75,000 standard deduction. IMPORTANT: slabs are revised in the Union Budget each February, so confirm the figures for the year you are actually filing for on incometax.gov.in before relying on them.",
    "tax income slabs rates", ITD, "2025-04-01"),

  e("tax.itr.deadline", "Income Tax Department", "Income-tax Act, 1961", "Section 139",
    "For an individual whose accounts do not need auditing, the due date to file the income tax return is 31 JULY following the end of the financial year. A belated return can be filed until 31 December, and an updated return (ITR-U) for up to a further period on payment of additional tax.",
    "Late filing fee under Section 234F: ₹5,000, reduced to ₹1,000 if total income is under ₹5 lakh. Interest under 234A runs on unpaid tax. Filing late also forfeits the right to carry forward most losses — the reason to file on time even when no tax is due. Deadlines are sometimes extended by CBDT circular; check before assuming.",
    "tax itr filing deadline", ITD),

  e("tax.80c", "Income Tax Department", "Income-tax Act, 1961", "Section 80C / 80D",
    "Section 80C allows a deduction of up to ₹1.5 lakh a year for EPF, PPF, ELSS, life insurance premium, principal on a home loan, tuition fees and five-year tax-saving deposits. Section 80D allows health insurance premium — ₹25,000 for self and family, and a further ₹50,000 for senior citizen parents.",
    "These are available under the OLD regime only. Under the new regime the main deduction available to a salaried person is the ₹75,000 standard deduction and the employer's NPS contribution under 80CCD(2).",
    "tax deduction 80c investment insurance", ITD),

  e("tax.tds.refund", "Income Tax Department", "Income-tax Act, 1961", "Form 26AS / AIS",
    "Check Form 26AS and the Annual Information Statement on the income tax portal before filing — they show every rupee of TDS deducted against your PAN and the transactions the department already knows about. If TDS exceeds your liability, filing a return is how you get the refund.",
    "A mismatch between your return and the AIS is the most common trigger for a notice. If TDS was deducted but does not appear in 26AS, the deductor has not filed properly — chase them, since you cannot claim credit for it otherwise. Refunds are paid only to a pre-validated bank account linked to your PAN.",
    "tax tds refund 26as", ITD),

  /* ---------------- FRAUD AND BANKING ---------------- */

  e("fraud.upi", "RBI", "Reserve Bank of India — Limited Liability Circular", "Customer liability",
    "If money leaves your account through an unauthorised electronic transaction and you report it to the BANK within THREE WORKING DAYS, your liability is ZERO. The bank must credit the amount back, and the burden of proving customer negligence is on the bank, not on you.",
    "Reporting within 4–7 working days caps liability at ₹5,000 to ₹25,000 depending on account type; beyond seven days it is governed by the bank's own policy, which is usually far less generous. So the action is immediate: (1) call the bank and get a written complaint reference, (2) call 1930 or file at cybercrime.gov.in, (3) freeze the card or UPI. The bank must resolve within 90 days. NEVER share an OTP — no bank, no UPI app and no official ever needs one.",
    "fraud upi bank liability cyber emergency", `${RBI}`),

  e("fraud.escalate", "RBI", "Reserve Bank — Integrated Ombudsman Scheme, 2021", "Banking Ombudsman",
    "If the bank does not resolve your complaint within 30 DAYS, or rejects it, escalate free of charge to the RBI Ombudsman at cms.rbi.org.in. It covers banks, NBFCs and payment system participants.",
    "You must complain to the bank FIRST and wait 30 days — a complaint filed before that is rejected as premature. Keep the bank's complaint reference number: it is the first thing the Ombudsman asks for. The service is free and no lawyer is needed. Compensation for loss and for mental agony can be awarded.",
    "fraud bank ombudsman complaint escalate", "https://cms.rbi.org.in"),

  e("credit.cibil", "TransUnion CIBIL / RBI", "Credit Information Companies (Regulation) Act, 2005", "Credit score",
    "You are entitled to ONE FREE full credit report each calendar year from each of the four credit bureaus — CIBIL, Experian, Equifax and CRIF High Mark. Scores run from 300 to 900; above 750 is generally treated as good.",
    "Dispute an error directly with the bureau — they must resolve it within 30 days, and since 2024 the lender must pay ₹100 per day of delay beyond that. Common damage: a closed loan still shown as open, or someone else's default on your file. Check before applying for a loan, not after being refused.",
    "credit score cibil loan report", "https://www.cibil.com"),

  /* ---------------- EPF ---------------- */

  e("epf.withdraw", "EPFO", "Employees' Provident Funds Act, 1952", "Form 19 / 31",
    "EPF can be withdrawn in full after two months of continuous unemployment, or partially while employed for a house, marriage, education, medical treatment or (after five years' service) home loan repayment. Claims are filed online on the EPFO member portal with a UAN and KYC-seeded Aadhaar.",
    "Withdrawal is TAX-FREE after five years of continuous service; before that, TDS applies (10% with PAN). Do not withdraw when changing jobs — TRANSFER instead (Form 13 online), because the five-year clock counts continuous membership, not one employer. Interest accrues even in an inoperative account until 58.",
    "epf pf retirement withdraw employment", EPFO),

  e("epf.pension", "EPFO", "Employees' Pension Scheme, 1995", "EPS",
    "A member who has completed 10 YEARS of eligible service qualifies for a monthly pension from age 58. With less than ten years, the pension corpus can be withdrawn as a lump sum using Form 10C.",
    "Ten years is the cliff — a member at nine and a half years should think carefully before withdrawing. Service across employers counts if the account is transferred rather than withdrawn, which is the practical reason to transfer.",
    "epf pension retirement eps", EPFO),

  /* ---------------- INSURANCE ---------------- */

  e("insurance.claim", "IRDAI", "IRDAI (Protection of Policyholders' Interests) Regulations", "Claim settlement",
    "A health insurance claim must be settled or rejected within a defined window after the last necessary document is received — cashless authorisation is required promptly, and reimbursement claims are to be settled without undue delay. A rejection must state the reason in writing with reference to the specific policy clause.",
    "If the insurer delays beyond the prescribed period, interest is payable on the claim amount. Escalate in this order: the insurer's grievance officer, then the IRDAI Bima Bharosa portal, then the Insurance Ombudsman (free, no lawyer, awards up to ₹50 lakh binding on the insurer). A consumer complaint under the Consumer Protection Act is also available for deficiency in service.",
    "insurance claim health rejection escalate", IRDAI),

  e("insurance.freelook", "IRDAI", "IRDAI regulations", "Free look period",
    "Every new life and health policy carries a FREE LOOK period — you may cancel within 30 days of receiving the policy document and get a refund of premium less proportionate risk cover, medical examination and stamp duty costs.",
    "This is the remedy for a mis-sold policy, and it is time-barred, so act as soon as you read the document and find it is not what was described. Mis-selling is also a ground for complaint to the insurer's grievance cell and then the Insurance Ombudsman.",
    "insurance mis-selling cancel refund", IRDAI),

  e("insurance.nominee", "IRDAI", "Insurance Act, 1938", "Section 39",
    "A nominee under a life insurance policy receives the money, and where the nominee is a parent, spouse or child they hold it as a BENEFICIAL nominee — the proceeds belong to them and not to the estate or other legal heirs.",
    "Keep nominations current after marriage, divorce or a death. For bank accounts a nominee is only a trustee for the legal heirs, which is a different rule and a common source of family disputes — the two are not the same.",
    "insurance nominee inheritance family", IRDAI),
];

module.exports = { DOMAIN, ENTRIES };
