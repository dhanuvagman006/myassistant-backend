/**
 * SEED CORPUS — Indian law, the provisions people actually ask about.
 *
 * SCOPE, HONESTLY STATED
 * ----------------------
 * This is not the Indian statute book. India has well over a thousand
 * central Acts plus every state's own legislation, and no seed file is
 * going to hold them. What this holds is the high-frequency core: the new
 * criminal laws, arrest and FIR rights, consumer, cheque bounce, tenancy,
 * employment, motor vehicles, family, cyber, RTI, and the constitutional
 * rights people invoke by name.
 *
 * Everything here is a PLAIN-LANGUAGE SUMMARY with a citation, not the bare
 * text of the section. Users get an answer they can act on plus the section
 * number and a link to verify it on indiacode.nic.in.
 *
 * Anything outside this corpus must be answered as "I don't have that" —
 * see corpus.js. The failure mode this whole design exists to prevent is a
 * confident, invented section number.
 *
 * MAINTENANCE: law changes. `effective` and `status` are carried per row so
 * a superseded provision can be marked rather than silently deleted, and
 * re-running the seeder updates rows by `slug` instead of duplicating them.
 * Verify against the source_url before relying on anything for a live
 * matter.
 */

const IC = "https://www.indiacode.nic.in";

/* ------------------------------------------------------------------ *
 * THE NEW CRIMINAL LAWS (in force 1 July 2024)
 * ------------------------------------------------------------------ */

const BNS_ACT = "Bharatiya Nyaya Sanhita, 2023";
const BNSS_ACT = "Bharatiya Nagarik Suraksha Sanhita, 2023";
const BSA_ACT = "Bharatiya Sakshya Adhiniyam, 2023";

const bns = (section, title, summary, detail, topics, replaces) => ({
  slug: `BNS:${section}`,
  act: BNS_ACT,
  act_short: "BNS",
  section,
  title,
  summary,
  detail,
  topics: `criminal ${topics}`.trim(),
  replaces,
  source_url: `${IC}/handle/123456789/20062`,
  status: "in_force",
  effective: "2024-07-01",
});

const bnss = (section, title, summary, detail, topics, replaces) => ({
  slug: `BNSS:${section}`,
  act: BNSS_ACT,
  act_short: "BNSS",
  section,
  title,
  summary,
  detail,
  topics: `procedure criminal ${topics}`.trim(),
  replaces,
  source_url: `${IC}/handle/123456789/20063`,
  status: "in_force",
  effective: "2024-07-01",
});

const PROVISIONS = [
  /* ---------------- CRIMINAL: OFFENCES ---------------- */

  bns("101", "Murder",
    "Culpable homicide is murder when the act is done with the intention of causing death, or with intention to cause an injury the offender knows is likely to cause death, or with knowledge that the act is so imminently dangerous it will in all probability cause death.",
    "Defines murder. The punishment is in Section 103.",
    "violence homicide", "IPC 300"),

  bns("103(1)", "Punishment for murder",
    "Whoever commits murder is punished with death or imprisonment for life, and is also liable to a fine.",
    "Punishment: death, or life imprisonment, plus fine. Non-bailable, cognizable, triable by Sessions Court.",
    "violence homicide punishment", "IPC 302"),

  bns("103(2)", "Murder by a group on grounds of identity (mob lynching)",
    "Where a group of five or more persons acting together commits murder on the ground of race, caste, community, sex, place of birth, language, personal belief or any similar ground, each member of that group is punished.",
    "Punishment: death, or life imprisonment, plus fine. This is a NEW offence — the IPC had no specific lynching provision.",
    "violence homicide hate", ""),

  bns("105", "Punishment for culpable homicide not amounting to murder",
    "Causing death without the intention or knowledge that makes it murder.",
    "Punishment: life imprisonment, or 5 to 10 years plus fine if the act was done with intent to cause death; up to 10 years plus fine if done with knowledge that it was likely to cause death.",
    "violence homicide", "IPC 304"),

  bns("106(1)", "Causing death by negligence",
    "Causing the death of any person by a rash or negligent act not amounting to culpable homicide.",
    "Punishment: up to 5 years and fine. For a registered medical practitioner acting in the course of medical procedure: up to 2 years and fine.",
    "negligence homicide medical", "IPC 304A"),

  bns("106(2)", "Hit and run — causing death by rash driving and fleeing",
    "Causing death by rash or negligent driving and escaping without reporting the incident to a police officer or magistrate soon after.",
    "Punishment: up to 10 years and fine. Widely reported and protested in 2024; check the current commencement position for this sub-section specifically before relying on it.",
    "motor driving negligence", ""),

  bns("109", "Attempt to murder",
    "Doing any act with the intention or knowledge that, had it caused death, it would be murder.",
    "Punishment: up to 10 years and fine. If hurt is caused: life imprisonment or up to 10 years and fine.",
    "violence", "IPC 307"),

  bns("108", "Abetment of suicide",
    "Abetting the commission of suicide by any person.",
    "Punishment: up to 10 years and fine.",
    "violence suicide", "IPC 306"),

  bns("115(2)", "Voluntarily causing hurt",
    "Voluntarily causing hurt to another person.",
    "Punishment: up to 1 year, or fine up to ₹10,000, or both.",
    "violence hurt", "IPC 323"),

  bns("117(2)", "Voluntarily causing grievous hurt",
    "Voluntarily causing grievous hurt — including emasculation, permanent loss of sight or hearing, disfiguration of head or face, fracture, or any hurt endangering life or causing 15+ days of severe pain or inability to follow ordinary pursuits.",
    "Punishment: up to 7 years and fine.",
    "violence hurt", "IPC 325"),

  bns("303(2)", "Theft",
    "Dishonestly taking movable property out of another's possession without their consent.",
    "Punishment: up to 3 years, or fine, or both. For a first-time offender in a theft of property under ₹5,000 who returns it, community service is provided for.",
    "property theft", "IPC 379"),

  bns("304", "Snatching",
    "Theft is snatching if, to commit it, the offender suddenly or quickly or forcibly seizes, secures, grabs or takes away any movable property from a person or their possession.",
    "Punishment: up to 3 years and fine. This is a NEW standalone offence — chain and phone snatching was previously charged as theft or robbery.",
    "property theft", ""),

  bns("309(4)", "Robbery",
    "Theft or extortion becomes robbery where the offender causes or attempts to cause death, hurt, or wrongful restraint, or the fear of it, in order to commit the offence.",
    "Punishment: rigorous imprisonment up to 10 years and fine; up to 14 years if committed on a highway between sunset and sunrise.",
    "property theft violence", "IPC 392"),

  bns("310(2)", "Dacoity",
    "Robbery committed by five or more persons acting conjointly.",
    "Punishment: life imprisonment, or rigorous imprisonment up to 10 years, and fine.",
    "property theft violence", "IPC 395"),

  bns("316(2)", "Criminal breach of trust",
    "Dishonestly misappropriating or converting to one's own use property that was entrusted to the offender.",
    "Punishment: up to 5 years and fine. Higher where the entrustment was to a carrier, clerk, servant, public servant, banker or agent.",
    "property fraud", "IPC 406"),

  bns("318(4)", "Cheating and dishonestly inducing delivery of property",
    "Cheating a person and thereby dishonestly inducing them to deliver property, or to make, alter or destroy a valuable security.",
    "Punishment: up to 7 years and fine. THIS IS THE PROVISION FORMERLY KNOWN AS SECTION 420 IPC — 'Section 420' no longer exists in Indian criminal law.",
    "property fraud cheating", "IPC 420"),

  bns("324", "Mischief",
    "Causing wrongful loss or damage to property with intent, or knowing it is likely.",
    "Punishment varies by the value of damage — from 6 months up to 5 years, with fine.",
    "property damage", "IPC 425"),

  bns("329", "Criminal trespass and house-trespass",
    "Entering into or upon property in the possession of another with intent to commit an offence or to intimidate, insult or annoy.",
    "Punishment: criminal trespass up to 3 months or ₹5,000 fine or both; house-trespass up to 1 year or ₹5,000 fine or both.",
    "property trespass", "IPC 441 447"),

  bns("351", "Criminal intimidation",
    "Threatening another with injury to their person, reputation or property, or to someone they are interested in, with intent to cause alarm or to make them do or omit something.",
    "Punishment: up to 2 years, or fine, or both; up to 7 years if the threat is of death or grievous hurt. Anonymous threats attract an additional penalty.",
    "threat intimidation", "IPC 503 506"),

  bns("356", "Defamation",
    "Making or publishing an imputation concerning any person intending to harm, or knowing it will harm, that person's reputation. Truth published for the public good is an exception.",
    "Punishment: simple imprisonment up to 2 years, or fine, or both, or community service. Defamation is also a separate civil wrong with a damages claim.",
    "reputation speech", "IPC 499 500"),

  bns("3(5)", "Common intention",
    "Where a criminal act is done by several persons in furtherance of a common intention, each is liable as if they had done it alone.",
    "Not an offence itself — a rule of joint liability, charged alongside the substantive offence.",
    "liability", "IPC 34"),

  bns("61(2)", "Criminal conspiracy",
    "An agreement between two or more persons to do an illegal act, or a legal act by illegal means.",
    "Punishment: for a conspiracy to commit a serious offence, the same as abetting that offence.",
    "liability conspiracy", "IPC 120B"),

  bns("111", "Organised crime",
    "Continuing unlawful activity by a crime syndicate — kidnapping, extortion, contract killing, land grabbing, financial scams, cybercrime and similar — carried on for material or financial benefit.",
    "Punishment: death or life imprisonment plus a minimum ₹10 lakh fine where it results in death; otherwise 5 years to life plus a minimum ₹5 lakh fine. NEW offence.",
    "organised syndicate", ""),

  bns("113", "Terrorist act",
    "Acts intended to threaten the unity, integrity, sovereignty, security or economic security of India, or to strike terror in the people.",
    "Punishment: death or life imprisonment without parole where it causes death; otherwise 5 years to life. NEW in the general criminal law — previously only under UAPA.",
    "terrorism", ""),

  bns("152", "Act endangering sovereignty, unity and integrity of India",
    "Purposely exciting secession, armed rebellion, subversive activities, or encouraging separatist feelings, by words, signs, visible representation or electronic communication.",
    "Punishment: life imprisonment or up to 7 years, plus fine. The offence of SEDITION (IPC 124A) has been repealed; this is a differently worded and narrower successor, not a renumbering of it.",
    "speech state", "IPC 124A (repealed, not equivalent)"),

  /* ---------------- CRIMINAL: WOMEN AND CHILDREN ---------------- */

  bns("63", "Rape — definition",
    "Defines rape, including the circumstances of absence of consent. Consent means an unequivocal voluntary agreement communicated by words, gestures or any form of verbal or non-verbal communication.",
    "The exception for a wife aged 18 or above remains in the statute; its constitutionality is under challenge before the Supreme Court.",
    "women sexual", "IPC 375"),

  bns("64", "Punishment for rape",
    "Rigorous imprisonment of not less than 10 years, extendable to life, and fine.",
    "Aggravated forms (by police officer, public servant, in custody, of a woman under 16 or 12, gang rape) carry higher minimums up to life meaning the remainder of natural life, or death in the gravest categories.",
    "women sexual punishment", "IPC 376"),

  bns("74", "Assault or use of criminal force on a woman with intent to outrage modesty",
    "Assaulting or using criminal force on a woman intending to outrage, or knowing it likely to outrage, her modesty.",
    "Punishment: 1 to 5 years and fine. Cognizable and non-bailable.",
    "women sexual harassment", "IPC 354"),

  bns("75", "Sexual harassment",
    "Physical contact and advances involving unwelcome and explicit sexual overtures; a demand or request for sexual favours; showing pornography against a woman's will; or making sexually coloured remarks.",
    "Punishment: up to 3 years and fine for the first three; up to 1 year or fine or both for sexually coloured remarks.",
    "women sexual harassment", "IPC 354A"),

  bns("78", "Stalking",
    "Following a woman and contacting or attempting to contact her to foster personal interaction repeatedly despite a clear indication of disinterest, or monitoring her use of the internet, email or any other electronic communication.",
    "Punishment: up to 3 years and fine for a first conviction; up to 5 years and fine for a subsequent one.",
    "women harassment cyber", "IPC 354D"),

  bns("79", "Word, gesture or act intended to insult the modesty of a woman",
    "Uttering any word, making any sound or gesture, or exhibiting any object intending it to be heard or seen by a woman, or intruding upon her privacy.",
    "Punishment: simple imprisonment up to 3 years and fine.",
    "women harassment privacy", "IPC 509"),

  bns("85", "Cruelty by husband or his relatives",
    "Subjecting a woman to cruelty by her husband or his relative.",
    "Punishment: up to 3 years and fine. Cognizable and non-bailable. Section 86 defines cruelty as conduct likely to drive a woman to suicide or cause grave injury, or harassment to coerce an unlawful demand for property or valuable security (dowry).",
    "women family dowry domestic", "IPC 498A"),

  bns("80", "Dowry death",
    "Where a woman dies of burns, bodily injury or otherwise than under normal circumstances within seven years of marriage, and it is shown she was subjected to cruelty or harassment for dowry soon before her death, her husband or his relative is deemed to have caused her death.",
    "Punishment: not less than 7 years, extendable to life.",
    "women family dowry", "IPC 304B"),

  /* ---------------- CRIMINAL PROCEDURE: RIGHTS ---------------- */

  bnss("173", "Registration of an FIR — including Zero FIR and e-FIR",
    "Information about a cognizable offence must be recorded by the officer in charge of a police station, read over to the informant, signed, and a free copy given to them immediately. It must be registered IRRESPECTIVE of where the offence was committed — this is a Zero FIR — and may be given electronically.",
    "Refusal to register an FIR can be escalated: send the substance in writing by post to the Superintendent of Police, and if still refused, apply to a Magistrate under BNSS 175(3). A free copy of the FIR is the informant's right, not a favour.",
    "fir police rights", "CrPC 154"),

  bnss("35", "When police may arrest without a warrant",
    "A police officer may arrest without a warrant in defined circumstances, mainly cognizable offences. For an offence punishable with less than seven years, the officer must instead issue a NOTICE of appearance where arrest is not necessary, and may not arrest a person who complies with that notice.",
    "This preserves the Arnesh Kumar v State of Bihar (2014) safeguards. An arrest for an offence under seven years must be justified as necessary — to prevent further offence, for proper investigation, to prevent tampering, or to secure attendance in court.",
    "arrest police rights warrant notice summons detained", "CrPC 41 41A"),

  bnss("47", "Right to be informed of the grounds of arrest",
    "A person arrested without a warrant must immediately be informed of the full grounds of the arrest and of their right to bail if the offence is bailable.",
    "Grounds must be actual grounds, not a bare reference to the section. The Supreme Court has held that failure to communicate grounds in writing vitiates the arrest.",
    // Topics carry the PHRASING people use out loud. Nobody asks about
    // "grounds of arrest" — they ask why they were arrested and whether the
    // police had to tell them, and none of those words appear in the
    // statutory language.
    "arrest rights grounds reason why told informing police station detained", "CrPC 50"),

  bnss("48", "Right to have a relative or friend informed of the arrest",
    "An arrested person is entitled to have information of the arrest and the place of detention conveyed immediately to a nominated relative, friend or other person.",
    "The police must record who was informed, and inform the arrested person of this right as soon as they are brought to the station.",
    "arrest rights family friend inform phone call relative", "CrPC 50A"),

  bnss("58", "Production before a Magistrate within 24 hours",
    "An arrested person must be produced before a Magistrate within 24 hours of arrest, excluding the time needed for the journey. Detention beyond 24 hours without a Magistrate's authority is illegal.",
    "This mirrors Article 22(2) of the Constitution and is not waivable.",
    "arrest rights custody", "CrPC 57"),

  bnss("187", "Default bail — release when investigation is not completed in time",
    "If the investigation is not completed and the charge sheet not filed within 60 days (offences punishable with less than 10 years) or 90 days (offences punishable with death, life, or 10 years or more), the accused is entitled to be released on bail.",
    "This is an INDEFEASIBLE right, but it must be claimed — apply on the day it accrues, because it is lost once the charge sheet is filed.",
    "bail custody rights", "CrPC 167(2)"),

  bnss("479", "Maximum period of detention of an undertrial prisoner",
    "An undertrial who has served half the maximum sentence for the offence must be released on bond. A FIRST-TIME offender who has served one-third of the maximum is entitled to release on bail.",
    "Does not apply to offences punishable with death or life imprisonment. The one-third rule for first-time offenders is new.",
    "bail custody rights", "CrPC 436A"),

  bnss("144", "Maintenance of wife, children and parents",
    "A Magistrate may order a person with sufficient means to pay a monthly maintenance allowance to a wife unable to maintain herself, a legitimate or illegitimate child, or parents unable to maintain themselves.",
    "Available regardless of religion. Interim maintenance may be ordered while the application is pending, and the application should ordinarily be disposed of within 60 days.",
    "family maintenance", "CrPC 125"),

  bnss("183", "Recording of confessions and statements by a Magistrate",
    "A Magistrate may record a confession or statement during investigation. A confession must be voluntary and preceded by a warning that the person is not bound to make it.",
    "A confession made to a police officer is NOT admissible against the accused — see BSA 22 and 23.",
    "evidence confession", "CrPC 164"),

  {
    slug: "BSA:63",
    act: BSA_ACT,
    act_short: "BSA",
    section: "63",
    title: "Admissibility of electronic records",
    summary:
      "Electronic records — WhatsApp messages, CCTV footage, email, call recordings — are admissible as documentary evidence, but must be accompanied by a certificate signed by the person in charge of the device and an expert, in the prescribed form.",
    detail:
      "Without the certificate, the electronic evidence is liable to be rejected. This is the successor to the much-litigated Section 65B of the Evidence Act, and the certificate requirement is stricter, not looser.",
    topics: "evidence electronic cyber procedure",
    replaces: "Evidence Act 65B",
    source_url: `${IC}/handle/123456789/20064`,
    status: "in_force",
    effective: "2024-07-01",
  },

  {
    slug: "BSA:23",
    act: BSA_ACT,
    act_short: "BSA",
    section: "23",
    title: "Confession to a police officer is not admissible",
    summary:
      "A confession made to a police officer cannot be proved against a person accused of an offence. A confession made while in police custody is not admissible unless made in the immediate presence of a Magistrate.",
    detail:
      "Only the part of a statement that distinctly leads to the discovery of a fact is admissible. This is the core protection against coerced confessions.",
    topics: "evidence confession rights police",
    replaces: "Evidence Act 25 26",
    source_url: `${IC}/handle/123456789/20064`,
    status: "in_force",
    effective: "2024-07-01",
  },

  /* ---------------- CONSTITUTION: FUNDAMENTAL RIGHTS ---------------- */

  ...[
    ["20(3)", "Right against self-incrimination",
      "No person accused of an offence shall be compelled to be a witness against himself.",
      "You cannot be forced to confess or to give testimonial evidence against yourself. Narco-analysis, polygraph and brain-mapping without consent were held unconstitutional in Selvi v State of Karnataka (2010)."],
    ["21", "Right to life and personal liberty",
      "No person shall be deprived of his life or personal liberty except according to procedure established by law.",
      "The broadest right in the Constitution. Read to include privacy (K.S. Puttaswamy, 2017), dignity, livelihood, health, a speedy trial, legal aid, and a clean environment."],
    ["22(1)", "Right to a lawyer on arrest",
      "No arrested person shall be denied the right to consult, and to be defended by, a legal practitioner of his choice.",
      "Applies from the moment of arrest. Free legal aid is available through the District Legal Services Authority if you cannot afford a lawyer."],
    ["22(2)", "Production before a Magistrate within 24 hours",
      "Every arrested person must be produced before the nearest Magistrate within 24 hours of arrest, excluding journey time.",
      "A constitutional guarantee, mirrored in BNSS 58."],
    ["32", "Right to constitutional remedies",
      "The right to move the Supreme Court directly for enforcement of fundamental rights. The Supreme Court may issue writs — habeas corpus, mandamus, prohibition, quo warranto and certiorari.",
      "Called 'the heart and soul of the Constitution' by Dr Ambedkar. Article 226 gives High Courts a wider writ power, covering both fundamental and other legal rights."],
    ["14", "Equality before the law",
      "The State shall not deny to any person equality before the law or the equal protection of the laws within India.",
      "Permits reasonable classification but forbids arbitrariness."],
    ["19(1)(a)", "Freedom of speech and expression",
      "All citizens have the right to freedom of speech and expression, subject to reasonable restrictions under Article 19(2).",
      "Restrictions are permitted only on the grounds listed in 19(2) — sovereignty, security, public order, decency, morality, contempt of court, defamation and incitement to an offence."],
  ].map(([section, title, summary, detail]) => ({
    slug: `CONST:${section}`,
    act: "Constitution of India, 1950",
    act_short: "Constitution",
    section: `Article ${section}`,
    title,
    summary,
    detail,
    topics: "rights constitution fundamental",
    replaces: "",
    source_url: `${IC}/handle/123456789/1362`,
    status: "in_force",
    effective: "1950-01-26",
  })),

  /* ---------------- CONSUMER ---------------- */

  {
    slug: "CPA2019:34",
    act: "Consumer Protection Act, 2019",
    act_short: "Consumer Protection Act",
    section: "34, 47, 58",
    title: "Where to file a consumer complaint — pecuniary jurisdiction",
    summary:
      "District Commission: goods or services paid for up to ₹50 lakh. State Commission: above ₹50 lakh and up to ₹2 crore. National Commission: above ₹2 crore.",
    detail:
      "Jurisdiction is based on the value of the consideration PAID, not the compensation claimed. A complaint may be filed where the complainant resides or works — you no longer have to travel to the seller's city. Filing can be done electronically on edaakhil.nic.in.",
    topics: "consumer complaint jurisdiction",
    replaces: "Consumer Protection Act 1986",
    source_url: `${IC}/handle/123456789/2263`,
    status: "in_force",
    effective: "2020-07-20",
  },
  {
    slug: "CPA2019:69",
    act: "Consumer Protection Act, 2019",
    act_short: "Consumer Protection Act",
    section: "69",
    title: "Time limit for a consumer complaint",
    summary:
      "A consumer complaint must be filed within TWO YEARS of the date on which the cause of action arose.",
    detail:
      "A delayed complaint can still be admitted if the Commission is satisfied there was sufficient cause for the delay, but the reasons must be recorded. Do not rely on condonation — file within two years.",
    topics: "consumer complaint limitation",
    replaces: "",
    source_url: `${IC}/handle/123456789/2263`,
    status: "in_force",
    effective: "2020-07-20",
  },
  {
    slug: "CPA2019:2(47)",
    act: "Consumer Protection Act, 2019",
    act_short: "Consumer Protection Act",
    section: "2(47)",
    title: "Unfair trade practice",
    summary:
      "Includes false representation about quality or standard, misleading advertisements, failing to issue a bill, refusing to take back defective goods or withdraw deficient services, and disclosing personal information given in confidence.",
    detail:
      "The 2019 Act also created the Central Consumer Protection Authority (CCPA), which can order recalls, refunds and penalties for misleading advertisements, including against endorsers.",
    topics: "consumer unfair",
    replaces: "",
    source_url: `${IC}/handle/123456789/2263`,
    status: "in_force",
    effective: "2020-07-20",
  },

  /* ---------------- CHEQUE BOUNCE ---------------- */

  {
    slug: "NIA:138",
    act: "Negotiable Instruments Act, 1881",
    act_short: "NI Act",
    section: "138",
    title: "Dishonour of cheque for insufficiency of funds",
    summary:
      "Where a cheque drawn to discharge a legally enforceable debt is returned unpaid for insufficient funds or because it exceeds the arranged amount, the drawer commits an offence.",
    detail:
      "Punishment: up to 2 years, or a fine up to twice the cheque amount, or both. STRICT TIMELINE: (1) the cheque must be presented within 3 months of its date; (2) a written demand notice must be sent within 30 DAYS of receiving the return memo; (3) the drawer gets 15 days to pay; (4) if unpaid, the complaint must be filed within 30 DAYS after that 15-day period expires. Missing any of these is usually fatal to the case.",
    topics: "cheque money recovery criminal",
    replaces: "",
    source_url: `${IC}/handle/123456789/2189`,
    status: "in_force",
    effective: "1989-04-01",
  },

  /* ---------------- MOTOR VEHICLES ---------------- */

  ...[
    ["185", "Driving under the influence",
      "Driving with alcohol exceeding 30 mg per 100 ml of blood, or under the influence of a drug.",
      "First offence: up to 6 months imprisonment and/or ₹10,000 fine. Second offence within 3 years: up to 2 years and/or ₹15,000 fine."],
    ["184", "Dangerous driving",
      "Driving at a speed or in a manner dangerous to the public, including jumping a red light, using a handheld phone while driving, or overtaking dangerously.",
      "First offence: 6 months to 1 year and/or ₹1,000–₹5,000. Second offence within 3 years: up to 2 years and/or ₹10,000."],
    ["194D", "Not wearing a helmet",
      "Riding a two-wheeler without protective headgear conforming to BIS standards.",
      "Fine ₹1,000 and disqualification of the driving licence for three months."],
    ["194B", "Not wearing a seat belt",
      "Driving or carrying a passenger without a fastened seat belt.",
      "Fine ₹1,000."],
    ["196", "Driving without insurance",
      "Using a vehicle without a valid third-party insurance policy.",
      "First offence: up to 3 months and/or ₹2,000. Subsequent: up to 3 months and/or ₹4,000."],
    ["166", "Claim for compensation after an accident",
      "An application for compensation arising out of a motor accident may be made by the injured person, or by the legal representatives of the deceased, to the Motor Accidents Claims Tribunal.",
      "There is NO limitation period for filing under Section 166 after the 2019 amendment removed it — but file promptly, since evidence degrades. Section 164 provides a fixed no-fault compensation of ₹5 lakh for death and ₹2.5 lakh for grievous hurt without proving negligence."],
  ].map(([section, title, summary, detail]) => ({
    slug: `MVA:${section}`,
    act: "Motor Vehicles Act, 1988 (as amended 2019)",
    act_short: "Motor Vehicles Act",
    section,
    title,
    summary,
    detail,
    topics: "motor driving traffic",
    replaces: "",
    source_url: `${IC}/handle/123456789/1798`,
    status: "in_force",
    effective: "2019-09-01",
  })),

  /* ---------------- EMPLOYMENT ---------------- */

  {
    slug: "POSH:9",
    act: "Sexual Harassment of Women at Workplace (Prevention, Prohibition and Redressal) Act, 2013",
    act_short: "POSH Act",
    section: "9",
    title: "Complaint of workplace sexual harassment",
    summary:
      "An aggrieved woman may make a written complaint to the Internal Committee within THREE MONTHS of the incident, or of the last incident in a series. The Committee may extend this by a further three months for recorded reasons.",
    detail:
      "Every workplace with 10 or more employees must constitute an Internal Committee headed by a woman, with at least half its members women and one external member from an NGO. The inquiry must be completed within 90 days. Conciliation is available at the woman's request but no monetary settlement may be the basis of it.",
    topics: "employment women harassment workplace",
    replaces: "",
    source_url: `${IC}/handle/123456789/2104`,
    status: "in_force",
    effective: "2013-12-09",
  },
  {
    slug: "GRATUITY:4",
    act: "Payment of Gratuity Act, 1972",
    act_short: "Payment of Gratuity Act",
    section: "4",
    title: "Entitlement to gratuity",
    summary:
      "Gratuity is payable to an employee on resignation, retirement or termination after FIVE years of continuous service. The five-year condition does not apply where employment ends due to death or disablement.",
    detail:
      "Calculated as 15 days' wages for every completed year of service (last drawn wages × 15/26 × years). The statutory ceiling is ₹20 lakh. It must be paid within 30 days of becoming payable; delay attracts simple interest.",
    topics: "employment wages gratuity",
    replaces: "",
    source_url: `${IC}/handle/123456789/1809`,
    status: "in_force",
    effective: "1972-09-16",
  },
  {
    slug: "MATERNITY:5",
    act: "Maternity Benefit Act, 1961 (as amended 2017)",
    act_short: "Maternity Benefit Act",
    section: "5",
    title: "Maternity leave",
    summary:
      "26 weeks of paid maternity leave for a woman with fewer than two surviving children, of which not more than 8 weeks may be taken before the expected delivery. For a woman with two or more surviving children, 12 weeks.",
    detail:
      "12 weeks for a commissioning or adopting mother (of a child below 3 months). Establishments with 50 or more employees must provide a crèche. Dismissal during maternity leave is prohibited.",
    topics: "employment women maternity",
    replaces: "",
    source_url: `${IC}/handle/123456789/1936`,
    status: "in_force",
    effective: "2017-04-01",
  },

  /* ---------------- FAMILY ---------------- */

  {
    slug: "HMA:13B",
    act: "Hindu Marriage Act, 1955",
    act_short: "Hindu Marriage Act",
    section: "13B",
    title: "Divorce by mutual consent",
    summary:
      "Both parties may jointly petition for divorce on the ground that they have been living separately for a year or more and have agreed the marriage should be dissolved. A second motion must be made after 6 months and within 18 months of the first.",
    detail:
      "The 6-month cooling-off period is directory, not mandatory, and can be waived by the court — Amardeep Singh v Harveen Kaur (2017). The Supreme Court has also held it can dissolve a marriage on irretrievable breakdown under Article 142 (Shilpa Sailesh v Varun Sreenivasan, 2023).",
    topics: "family divorce marriage",
    replaces: "",
    source_url: `${IC}/handle/123456789/1560`,
    status: "in_force",
    effective: "1976-05-27",
  },
  {
    slug: "HSA:6",
    act: "Hindu Succession Act, 1956 (as amended 2005)",
    act_short: "Hindu Succession Act",
    section: "6",
    title: "Daughters as coparceners in ancestral property",
    summary:
      "A daughter of a coparcener becomes a coparcener in her own right in the same manner as a son, with the same rights and liabilities in coparcenary property.",
    detail:
      "Vineeta Sharma v Rakesh Sharma (2020) settled that this right is by BIRTH — the father need not have been alive on 9 September 2005 for the daughter to claim. It applies regardless of when the daughter was born.",
    topics: "family property succession inheritance women",
    replaces: "",
    source_url: `${IC}/handle/123456789/1626`,
    status: "in_force",
    effective: "2005-09-09",
  },
  {
    slug: "DV:12",
    act: "Protection of Women from Domestic Violence Act, 2005",
    act_short: "Domestic Violence Act",
    section: "12",
    title: "Application to a Magistrate for protection",
    summary:
      "An aggrieved woman, a Protection Officer or any other person may apply to the Magistrate for relief — a protection order, a residence order, monetary relief, custody of children, or compensation.",
    detail:
      "This is a CIVIL remedy and is available alongside a criminal case under BNS 85. Domestic violence includes physical, sexual, verbal, emotional and economic abuse. A woman has the right to reside in the shared household even if she has no title to it. Applications are to be disposed of within 60 days.",
    topics: "family women domestic violence",
    replaces: "",
    source_url: `${IC}/handle/123456789/2021`,
    status: "in_force",
    effective: "2006-10-26",
  },
  {
    slug: "SMA:5",
    act: "Special Marriage Act, 1954",
    act_short: "Special Marriage Act",
    section: "5, 6, 7",
    title: "Inter-faith and civil marriage — notice period",
    summary:
      "Parties give written notice to the Marriage Officer of the district where one has resided for at least 30 days. The notice is published and any person may object within 30 days. If no valid objection is upheld, the marriage is solemnised.",
    detail:
      "The public notice requirement has been read down by some High Courts (notably Allahabad in Safiya Sultana, 2021) as optional, on privacy grounds. Practice varies by state — check locally.",
    topics: "family marriage interfaith",
    replaces: "",
    source_url: `${IC}/handle/123456789/1591`,
    status: "in_force",
    effective: "1954-10-09",
  },

  /* ---------------- CYBER / DATA ---------------- */

  ...[
    ["66C", "Identity theft",
      "Fraudulently or dishonestly using the electronic signature, password or any other unique identification feature of another person.",
      "Punishment: up to 3 years and a fine up to ₹1 lakh."],
    ["66D", "Cheating by personation using a computer resource",
      "Cheating by personation using a communication device or computer resource — the provision most online fraud and phishing is charged under.",
      "Punishment: up to 3 years and a fine up to ₹1 lakh."],
    ["66E", "Violation of privacy",
      "Intentionally capturing, publishing or transmitting the image of a private area of any person without consent, in circumstances violating their privacy.",
      "Punishment: up to 3 years, or a fine up to ₹2 lakh, or both."],
    ["67", "Publishing obscene material in electronic form",
      "Publishing or transmitting obscene material in electronic form.",
      "Punishment: first conviction up to 3 years and a fine up to ₹5 lakh; subsequent up to 5 years and ₹10 lakh. Section 67A covers sexually explicit material and 67B child sexual abuse material, with higher punishments."],
  ].map(([section, title, summary, detail]) => ({
    slug: `IT:${section}`,
    act: "Information Technology Act, 2000",
    act_short: "IT Act",
    section,
    title,
    summary,
    detail,
    topics: "cyber online fraud privacy",
    replaces: "",
    source_url: `${IC}/handle/123456789/1999`,
    status: "in_force",
    effective: "2009-10-27",
  })),

  {
    slug: "CYBER:1930",
    act: "National Cybercrime Reporting Portal",
    act_short: "Cybercrime helpline",
    section: "Helpline 1930",
    title: "Reporting online financial fraud immediately",
    summary:
      "Report online financial fraud on the national helpline 1930 or at cybercrime.gov.in as soon as it happens. The first few hours are decisive — reporting quickly allows the money to be frozen in the beneficiary account before it is withdrawn.",
    detail:
      "This is a reporting channel, not a statutory provision. Also inform your bank in writing at once: under the RBI's limited liability framework, a customer who reports an unauthorised electronic transaction within 3 working days generally bears zero liability.",
    topics: "cyber fraud emergency banking",
    replaces: "",
    source_url: "https://cybercrime.gov.in",
    status: "in_force",
    effective: "2021-01-01",
  },

  /* ---------------- TRANSPARENCY ---------------- */

  {
    slug: "RTI:6",
    act: "Right to Information Act, 2005",
    act_short: "RTI Act",
    section: "6, 7",
    title: "Filing an RTI application and the time limits",
    summary:
      "Any citizen may request information from a public authority in writing or electronically, with a ₹10 fee. No reason for seeking the information need be given.",
    detail:
      "The Public Information Officer must reply within 30 DAYS; within 48 HOURS where the information concerns the life or liberty of a person; and within 35 days if routed through an Assistant PIO. If the reply is late, the information must be supplied FREE. First appeal to the appellate authority within 30 days; second appeal to the Information Commission within 90 days.",
    topics: "rti transparency government",
    replaces: "",
    source_url: `${IC}/handle/123456789/2065`,
    status: "in_force",
    effective: "2005-10-12",
  },

  /* ---------------- LIMITATION ---------------- */

  {
    slug: "LIMITATION:general",
    act: "Limitation Act, 1963",
    act_short: "Limitation Act",
    section: "Schedule (Articles 54, 55, 62, 65, 113)",
    title: "How long you have to file a civil case",
    summary:
      "Suit on a contract or for recovery of money: 3 years from when the money became due. Suit for possession of immovable property: 12 years from when possession became adverse. Suit for specific performance: 3 years from the date fixed for performance. Residuary: 3 years from when the right to sue accrues.",
    detail:
      "A suit filed after the limitation period is dismissed as time-barred however strong its merits. A written acknowledgement of the debt, or a part payment, before the period expires starts a fresh 3-year period (Sections 18 and 19). Appeals have far shorter periods — usually 30 to 90 days.",
    topics: "civil limitation procedure recovery",
    replaces: "",
    source_url: `${IC}/handle/123456789/1595`,
    status: "in_force",
    effective: "1964-01-01",
  },

  /* ---------------- TENANCY ---------------- */

  {
    slug: "TENANCY:model",
    act: "Model Tenancy Act, 2021 (and State Rent Acts)",
    act_short: "Tenancy law",
    section: "General",
    title: "Landlord and tenant rights — and why the answer depends on your state",
    summary:
      "Rent control and tenancy are STATE subjects. The Model Tenancy Act 2021 is a central template that states may adopt, amend or ignore — it does not itself apply unless your state has enacted it. Maharashtra, Delhi, Karnataka, Tamil Nadu and others each have their own Rent Act, and the rules differ substantially.",
    detail:
      "Under the Model Act: a written agreement is mandatory; the security deposit is capped at 2 months' rent for residential premises; the landlord must give 24 hours' notice before entering; and a tenant who overstays after the tenancy ends pays double rent for two months and four times thereafter. Disputes go to a Rent Authority, not a civil court. Check whether your state has adopted it before relying on any of this.",
    topics: "property tenancy rent landlord",
    replaces: "",
    source_url: "https://mohua.gov.in",
    status: "partially_in_force",
    effective: "2021-06-02",
  },

  /* ---------------- ACCESS TO JUSTICE ---------------- */

  {
    slug: "LSA:12",
    act: "Legal Services Authorities Act, 1987",
    act_short: "Legal Services Authorities Act",
    section: "12",
    title: "Free legal aid — who is entitled",
    summary:
      "Free legal services are available as of right to: members of a Scheduled Caste or Scheduled Tribe; victims of trafficking or beggar; women and children; persons with disabilities; victims of mass disaster, violence, flood, drought, earthquake or industrial disaster; industrial workmen; persons in custody; and anyone whose annual income is below the limit prescribed by the State.",
    detail:
      "Apply to the District Legal Services Authority (DLSA) at your district court, or call the national legal aid helpline 15100. Legal aid covers a lawyer, court fees and process costs. Lok Adalats offer free settlement of pending and pre-litigation disputes, and their awards are final and binding.",
    topics: "rights legalaid access procedure",
    replaces: "",
    source_url: `${IC}/handle/123456789/1900`,
    status: "in_force",
    effective: "1995-11-09",
  },
];

module.exports = { PROVISIONS };
