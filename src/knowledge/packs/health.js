/**
 * PACK: HEALTH — FIRST AID AND ESCALATION ONLY.
 *
 * THE BOUNDARY, AND WHY IT IS DRAWN HERE
 * --------------------------------------
 * This pack does NOT diagnose, does not name conditions from symptoms, and
 * does not give doses or recommend medicines. That is not timidity — it is
 * where the value actually is. An assistant guessing at a diagnosis is both
 * dangerous and useless, because the user still has to see a doctor. An
 * assistant that recognises a red flag and says "this is an emergency, call
 * 112 now, and while you wait do this" can genuinely change an outcome.
 *
 * So every entry is one of three things:
 *   • what to DO in the first minutes of an emergency, before help arrives
 *   • the RED FLAGS that mean go now rather than wait
 *   • who to CALL
 *
 * No dosages appear anywhere in this pack, deliberately. Dose depends on
 * weight, age, kidney function and what else the person takes, none of
 * which the assistant knows, and a spoken number would be acted on.
 *
 * Sources are the standard public-health positions (WHO, Indian Red Cross,
 * NHM helplines). Where guidance differs between authorities, the entry
 * gives the conservative action.
 */

const DOMAIN = "health";

const e = (slug, source_short, source_title, ref, title, summary, detail, topics, source_url) => ({
  slug: `HEALTH:${slug}`,
  domain: DOMAIN,
  source_title,
  source_short,
  ref,
  title,
  summary,
  detail,
  topics: `health ${topics}`.trim(),
  replaces: "",
  source_url,
  status: "in_force",
  effective: "",
});

const NHM = "https://nhm.gov.in";

const ENTRIES = [
  /* ---------------- THE BOUNDARY ITSELF ---------------- */

  e("boundary", "Assistant policy", "Health capability boundary", "Scope",
    "I can help with first aid, recognising an emergency, and who to call. I cannot diagnose a condition, tell you what illness you have, or recommend a medicine or a dose — that needs a doctor who can examine you and knows your history.",
    "If asked for a diagnosis or a medicine, say this plainly and redirect: describe what to watch for, when it becomes urgent, and offer to find the nearest hospital or call someone. Never name a likely condition from symptoms and never state a dose, even for a common over-the-counter medicine.",
    "boundary scope diagnosis medicine", ""),

  /* ---------------- WHO TO CALL ---------------- */

  e("emergency.numbers", "Government of India", "National emergency helplines", "Helplines",
    "112 is the all-in-one emergency number across India — police, fire and ambulance. 108 is the ambulance number in most states, and 102 is for pregnancy and newborn transport. 104 is the health advice helpline.",
    "Other lines worth knowing: 1098 for a child in distress, 14416 or 1800-891-4416 for Tele-MANAS mental health support, 1930 for financial cyber fraud, 1091 women's helpline, 181 women in distress. 112 works from a locked phone and can be triggered by pressing the power button three times on most handsets.",
    "emergency helpline ambulance police call", "https://112.gov.in"),

  /* ---------------- RED FLAGS: GO NOW ---------------- */

  e("redflag.heart", "WHO / standard first aid", "Cardiac emergency red flags", "Chest pain",
    "Call 112 immediately for: chest pain or heavy pressure lasting more than a few minutes, pain spreading to the arm, jaw, neck or back, breathlessness with sweating or nausea, or sudden collapse. Do not drive yourself — an ambulance can begin treatment on the way.",
    "Keep the person sitting, calm and still, loosen tight clothing, and do not let them walk about. If they are unresponsive and not breathing normally, start hands-only CPR. Symptoms in women and in people with diabetes are often quieter — breathlessness, fatigue or nausea without dramatic chest pain — which is why those are on this list.",
    "emergency heart cardiac chest pain", NHM),

  e("redflag.stroke", "WHO / standard first aid", "Stroke red flags — FAST", "Stroke",
    "FAST: Face drooping on one side, Arm weakness on one side, Speech slurred or confused, Time to call 112 immediately. Also sudden severe headache, sudden loss of vision, or sudden loss of balance.",
    "TIME IS THE TREATMENT — clot-busting treatment works only within a few hours of the first symptom, so note the time symptoms STARTED and tell the hospital. Do not give food, drink or medicine, and do not wait to see if it passes. Go to a hospital with a stroke unit if there is a choice.",
    "emergency stroke brain fast", NHM),

  e("redflag.general", "Standard triage guidance", "When to go to hospital now", "Red flags",
    "Go to an emergency department without waiting for: difficulty breathing, uncontrolled bleeding, a fit or seizure, unconsciousness or confusion, a head injury with vomiting or drowsiness, severe abdominal pain, a burn larger than the person's palm, suspected poisoning or overdose, or any sudden severe symptom that is unlike anything before.",
    "In a child, add: unusual drowsiness or floppiness, a rash that does not fade when pressed with a glass, dehydration with no wet nappy for many hours, laboured breathing, or fever in a baby under 3 months. In pregnancy, add: bleeding, severe headache with vision changes, reduced fetal movement, or fluid leaking.",
    "emergency redflag hospital child pregnancy", NHM),

  /* ---------------- FIRST AID: WHAT TO DO ---------------- */

  e("firstaid.cpr", "Indian Red Cross / WHO", "Hands-only CPR", "CPR",
    "If someone is unresponsive and not breathing normally: call 112 on speaker, then push hard and fast in the centre of the chest, about twice per second, letting the chest come all the way back up between pushes. Keep going until they respond or help arrives.",
    "Hands-only CPR — no rescue breaths — is what untrained bystanders should do, and it works. Push to a depth of about 5 cm in an adult. If an AED is available, switch it on and follow its spoken instructions. Doing imperfect CPR is far better than doing none.",
    "emergency cpr resuscitation", NHM),

  e("firstaid.choking", "Indian Red Cross / WHO", "Choking", "Choking",
    "If the person can cough or speak, encourage them to keep coughing. If they cannot breathe, speak or cough: give up to 5 firm back blows between the shoulder blades with the heel of your hand, then up to 5 abdominal thrusts, and alternate. Call 112.",
    "For an INFANT under one year, use back blows and CHEST thrusts, never abdominal thrusts, holding them face down along your forearm. For a pregnant or very large person, use chest thrusts instead of abdominal. If they become unresponsive, start CPR.",
    "emergency choking airway infant", NHM),

  e("firstaid.bleeding", "Indian Red Cross", "Severe bleeding", "Bleeding",
    "Press hard directly on the wound with a clean cloth and keep pressing — do not lift it to look. Add more cloth on top if it soaks through. Raise the limb if you can. Call 112 for bleeding that spurts, does not slow, or comes from a deep wound.",
    "Do not use a tourniquet unless the bleeding is catastrophic and pressure has failed; if you do, note the time it was applied. Do not remove an embedded object — pad around it and leave it in place, because it may be plugging the wound.",
    "emergency bleeding wound", NHM),

  e("firstaid.burns", "WHO", "Burns", "Burns",
    "Cool the burn under cool running water for 20 MINUTES. Remove rings, watches and tight clothing near the burn before it swells, but do not peel off anything stuck to the skin. Cover loosely with cling film or a clean non-fluffy cloth.",
    "NEVER put ice, toothpaste, butter, oil, ash or turmeric on a burn — all of these are common in India and all make the injury and the infection risk worse. Go to hospital for any burn larger than the person's palm, any burn to the face, hands, feet, joints or genitals, any burn in a child, and any electrical or chemical burn.",
    "emergency burns scald", NHM),

  e("firstaid.snakebite", "WHO / NHM", "Snake bite", "Snake bite",
    "Keep the person still and calm, and get them to a hospital with antivenom as fast as possible. Immobilise the bitten limb like a fracture and keep it BELOW heart level. Remove rings and anything tight. Note the time of the bite.",
    "Do NOT cut the wound, suck the venom, apply a tourniquet, wash the site vigorously, or apply ice or herbs — every one of these is traditional, harmful, and delays the only treatment that works, which is antivenom in a hospital. Do not try to catch the snake; a photograph from a safe distance is enough.",
    "emergency snakebite rural", NHM),

  e("firstaid.seizure", "WHO", "Seizure", "Seizure",
    "Move objects out of the way, cushion the head, and let the seizure run its course. Time it. When the movements stop, roll the person onto their side. Stay until they are fully alert.",
    "Do NOT restrain them and do NOT put anything in the mouth — a spoon, cloth or fingers will break teeth or be bitten, and the tongue cannot be swallowed. Call 112 if the seizure lasts more than 5 minutes, if another follows immediately, if it is their first, if they are injured or pregnant, or if they do not regain consciousness.",
    "emergency seizure epilepsy", NHM),

  e("firstaid.heatstroke", "NDMA / WHO", "Heat stroke", "Heat stroke",
    "Heat stroke is an emergency: hot dry skin, a body temperature above about 40°C, confusion, agitation or collapse, often with the person having STOPPED sweating. Call 112, move them into shade, remove outer clothing and cool them aggressively with water and fanning, concentrating on the neck, armpits and groin.",
    "Do not give fluids to anyone who is confused or not fully conscious. Heat EXHAUSTION — heavy sweating, weakness, nausea, cool clammy skin — is the earlier stage: move to shade, cool, and give ORS or water. It becomes heat stroke if ignored, and India's summer makes this one of the most preventable emergencies here.",
    "emergency heat summer dehydration", "https://ndma.gov.in"),

  e("firstaid.dehydration", "WHO", "Dehydration and ORS", "ORS",
    "For diarrhoea or vomiting, the treatment that matters is fluid replacement with ORS, taken in small frequent sips rather than large amounts at once. Zinc supplementation alongside ORS is standard for children with diarrhoea.",
    "Use a proper ORS sachet mixed with the stated volume of clean water — home mixtures made by guesswork can be dangerously concentrated. Go to hospital for: no urine for many hours, sunken eyes, a child who is unusually floppy or drowsy, blood in the stool, persistent vomiting, or a high fever alongside.",
    "diarrhoea dehydration ors child", NHM),

  e("firstaid.poisoning", "WHO", "Poisoning and overdose", "Poisoning",
    "Call 112 immediately. Do NOT make the person vomit — with corrosives and petroleum products this causes far worse injury on the way back up. Take the container, label or medicine strip with you to the hospital.",
    "For a chemical on the skin, remove contaminated clothing and rinse with plenty of running water. For eyes, rinse with clean water for at least 15 minutes. Keep any vomit for the hospital to see. If they are unconscious but breathing, put them on their side.",
    "emergency poisoning overdose", NHM),

  e("mental.crisis", "MoHFW", "Tele-MANAS", "Mental health crisis",
    "For someone in mental distress or at risk of suicide, Tele-MANAS is a free 24×7 national service on 14416 or 1800-891-4416, available in many Indian languages.",
    "Stay with the person, listen without arguing or minimising, and remove access to means of harm if you safely can. Ask directly and calmly whether they are thinking of ending their life — asking does not plant the idea, and it is the question that opens the conversation. If there is immediate danger, call 112. Attempting suicide is no longer treated as a crime — the Mental Healthcare Act 2017 presumes severe stress and requires care, not prosecution.",
    "emergency mental health suicide crisis", "https://telemanas.mohfw.gov.in"),

  /* ---------------- RIGHTS ---------------- */

  e("rights.emergency.care", "Supreme Court / MoHFW", "Right to emergency medical care", "Emergency care",
    "No hospital, government or private, may refuse immediate emergency treatment to save a life — including in a road accident case — and may not delay it waiting for police formalities or payment.",
    "This follows Parmanand Katara v Union of India (1989) and the Good Samaritan protections now in Section 134A of the Motor Vehicles Act: a bystander who helps an accident victim cannot be harassed, made to pay, or forced to be a witness, and may leave after giving their name if they choose. If a hospital refuses, note the time and names and complain to the state health authority.",
    "rights emergency hospital accident", NHM),
];

module.exports = { DOMAIN, ENTRIES };
