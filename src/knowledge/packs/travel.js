/**
 * PACK: TRAVEL AND TRANSPORT.
 *
 * Rail, air and road — the rules people actually lose money to: refund
 * slabs, Tatkal timings, what an airline owes you when it cancels, and the
 * documents that must be in the vehicle.
 *
 * Fares and some charges change; rights and procedures change slowly. Where
 * a figure is given it is the published rule with the official source
 * linked, and entries that are known to drift say so rather than pretending
 * to be permanent.
 */

const DOMAIN = "travel";

const e = (slug, source_short, source_title, ref, title, summary, detail, topics, source_url) => ({
  slug: `TRAVEL:${slug}`,
  domain: DOMAIN,
  source_title,
  source_short,
  ref,
  title,
  summary,
  detail,
  topics: `travel ${topics}`.trim(),
  replaces: "",
  source_url,
  status: "in_force",
  effective: "",
});

const IRCTC = "https://www.irctc.co.in";
const DGCA = "https://www.dgca.gov.in";

const ENTRIES = [
  /* ---------------- RAIL ---------------- */

  e("rail.tatkal", "IRCTC", "Indian Railways — Tatkal scheme", "Tatkal",
    "Tatkal booking opens ONE DAY before the train's departure from its originating station, not before your boarding station: 10:00 am for AC classes and 11:00 am for sleeper and non-AC.",
    "Tatkal tickets are normally NON-REFUNDABLE on cancellation of a confirmed ticket — this is the most common and most expensive surprise. A waitlisted Tatkal ticket that does not confirm is refunded automatically less clerkage. Premium Tatkal uses dynamic pricing. Have passenger details saved in your IRCTC master list beforehand; the window is decided in seconds.",
    "rail train tatkal booking", IRCTC),

  e("rail.refund", "IRCTC", "Railway Passengers (Cancellation of Tickets and Refund of Fare) Rules, 2015", "Cancellation",
    "For a CONFIRMED ticket, cancellation charges depend on how early you cancel: a flat charge per passenger if cancelled more than 48 hours before departure (higher for higher classes), 25% of the fare between 48 and 12 hours, and 50% between 12 and 4 hours. Within 4 hours of departure, no refund on a confirmed ticket.",
    "RAC and waitlisted tickets can be cancelled up to 30 minutes before departure for a refund less clerkage. If the train is LATE by more than three hours and you choose not to travel, you are entitled to a full refund. If the train is cancelled by the railway, the refund is automatic for e-tickets. Missed the train? File a TDR — you cannot simply cancel afterwards.",
    "rail train refund cancellation tdr", IRCTC),

  e("rail.rights", "Indian Railways", "Passenger entitlements", "Passenger rights",
    "If no berth is available in the class you paid for and you are accommodated in a lower class, you are entitled to the fare difference back. Children aged 5 to under 12 need a full-fare ticket if a separate berth is wanted, otherwise a half-fare ticket without a berth.",
    "Carry the ID you booked with — an e-ticket is invalid without the original photo ID of at least one passenger travelling. Complaints and help during travel: RailMadad on 139 or railmadad.indianrailways.gov.in, which is far faster than complaining afterwards. Emergency and security on a train: 182.",
    "rail train rights complaint", "https://railmadad.indianrailways.gov.in"),

  /* ---------------- AIR ---------------- */

  e("air.cancellation", "DGCA", "Civil Aviation Requirements, Section 3, Series M, Part IV", "Cancellation and delay",
    "If an airline CANCELS your flight without at least two weeks' notice, or you are informed within that window and the alternative offered does not suit, you are entitled to a full refund OR an alternative flight, and in defined cases to compensation as well.",
    "For long delays the airline must provide meals and refreshments, and hotel accommodation where an overnight wait is involved. These duties do NOT apply where the cause is outside the airline's control — weather, air traffic control, security or an act of God — which is the exemption airlines rely on most. A refund must be paid within the prescribed period, not held as a credit shell unless you agree.",
    "air flight cancellation delay refund compensation", DGCA),

  e("air.denied.boarding", "DGCA", "Civil Aviation Requirements, Section 3, Series M, Part IV", "Denied boarding",
    "If you are denied boarding because the flight is overbooked and you checked in on time, the airline must first ask for volunteers. If you did not volunteer, it must either put you on an alternative flight within an hour of the original departure, or pay compensation in addition to carrying you.",
    "Compensation is calculated against the one-way basic fare plus airline fuel charge, with a ceiling, and increases with the delay to your eventual departure. You do not lose the right by accepting the alternative flight. Keep the boarding pass and the written denial reason.",
    "air flight overbooking denied boarding", DGCA),

  e("air.baggage", "DGCA", "Carriage by Air Act, 1972 / Montreal Convention", "Baggage",
    "For lost, damaged or delayed checked baggage, report it AT THE AIRPORT before leaving and get a Property Irregularity Report — a claim made after you leave the terminal is much harder to pursue.",
    "Liability on international carriage is capped under the Montreal Convention by weight-independent limits in Special Drawing Rights; domestic limits are set by DGCA rules. Claims must be made in writing within short deadlines — typically 7 days for damage and 21 days for delay from the date the baggage was placed at your disposal. Keep receipts for essentials bought because of the delay.",
    "air flight baggage lost claim", DGCA),

  e("air.grievance", "MoCA", "AirSewa", "Complaint escalation",
    "Complain to the airline first, and escalate unresolved air travel grievances on the AirSewa portal or app, which routes them to the airline and to DGCA.",
    "Deficiency in service by an airline is also a consumer complaint under the Consumer Protection Act 2019 — the consumer commission route is often what actually produces compensation, and can be filed where you live. Keep the PNR, boarding pass and all written communication.",
    "air flight complaint grievance consumer", "https://airsewa.gov.in"),

  /* ---------------- ROAD ---------------- */

  e("road.documents", "MoRTH", "Motor Vehicles Act, 1988", "Documents to carry",
    "You must be able to produce a valid driving licence, the vehicle registration certificate, valid third-party insurance, and a Pollution Under Control certificate. DIGITAL copies in DigiLocker or mParivahan are legally valid and must be accepted.",
    "A photograph of the document in your phone gallery is NOT valid — it must be the DigiLocker or mParivahan record pulled from the issuing authority. Driving without insurance is punishable under Section 196, and an uninsured at-fault driver is personally liable for the whole of any accident claim, which is the real risk rather than the fine.",
    "road driving documents rc insurance puc", "https://parivahan.gov.in"),

  e("road.interstate", "MoRTH", "Motor Vehicles Act, 1988", "Interstate travel",
    "A private vehicle may be driven anywhere in India on its home registration. If you move to another state and keep the vehicle there for more than TWELVE MONTHS, it must be re-registered in the new state, with a No Objection Certificate from the original RTO.",
    "Road tax is a state subject: on re-registration the new state charges its own tax and you may claim a refund of the unused portion from the original state. Commercial vehicles need permits for interstate operation; private cars do not. The BH (Bharat) series registration avoids re-registration for eligible government and large-company employees who transfer between states.",
    "road driving interstate registration tax", "https://parivahan.gov.in"),

  e("road.accident", "MoRTH", "Motor Vehicles Act, 1988", "After an accident",
    "Stop, help the injured, and report the accident to the police. Under Section 134A a Good Samaritan who helps an accident victim cannot be harassed or forced to become a witness, and cannot be made liable for the treatment cost.",
    "Take photographs of the scene, both vehicles, the number plates and any injuries, and get the other driver's licence, RC and insurance details. Report to your insurer promptly — most policies require notice within a short window. Compensation claims go to the Motor Accidents Claims Tribunal under Section 166; Section 164 gives fixed no-fault compensation without proving negligence.",
    "road accident insurance claim police", "https://parivahan.gov.in"),

  /* ---------------- ABROAD ---------------- */

  e("abroad.help", "MEA", "Ministry of External Affairs", "Indians abroad",
    "The Indian embassy or consulate is the point of contact if you lose your passport, are detained, or face an emergency abroad. MADAD (madad.gov.in) is the online consular grievance portal.",
    "Register on the eMigrate portal before taking up employment abroad — an unregistered recruiting agent is the most common route into exploitation. For a lost passport abroad, report to the local police, get a report, and apply to the mission for an Emergency Certificate to return or a replacement passport. Keep digital copies of your passport, visa and tickets separately from the originals.",
    "travel abroad passport embassy emergency", "https://www.mea.gov.in"),
];

module.exports = { DOMAIN, ENTRIES };
