/**
 * SPOKEN REQUESTS AND THE TOOLS THAT ANSWER THEM - shared by
 * tool-call-eval.js (the cascade's model) and gpt-live-tools-check.js (the
 * GPT-Live backend). Taken from real Conversations.
 */
// [what they said, the tools that count as right; [] = no tool]
const CASES = [
  ["show me a picture of Virat Kohli", ["show_pictures"]],
  ["What is new thing emerging in technology?", ["web_search"]],
  ["Can you tell me about Dr. M. N. Rajendra Kumar's health condition?", ["web_search"]],
  ["call Neha and tell her that papa is coming tomorrow", ["place_phone_call"]],
  ["Remind me to take an umbrella half an hour before 2 pm today.", ["create_reminder"]],
  ["What is on my calendar today?", ["list_calendar_events", "list_reminders"]],
  // play_daily_brief plays the same brief in the player (2026-10-06).
  ["Give me my brief for today.", ["daily_brief", "play_daily_brief"]],
  ["I have a meeting tomorrow at 9 am", ["create_calendar_event"]],
  ["can you open swiggy", ["open_named_app"]],
  ["Is there an IKEA near this place?", ["find_places_nearby"]],
  ["Open the camera", ["open_named_app", "phone_control"]],
  ["I want the judgment to be downloaded. Search in Google and provide me.", ["web_search"]],
  ["Tell me Neha Shetty's present address in Mumbai.", ["show_address", "lookup_person", "web_search"]],
  ["Remember Neha's address: Therese Apartment, plot 179, Waterfield Road, Bandra West, Mumbai", ["remember_address"]],
  ["Can you tell me my present location address?", ["get_current_location"]],
  ["Uber app", ["open_named_app"]],
  ["What time is the flight from Mumbai to Bengaluru tomorrow?", ["web_search"]],
  ["Create a nice birthday card for Ravi Shankar Shetty", ["make_greeting_poster", "generate_image"]],
  // show_news is the news reader built for this (2026-10-06).
  ["What is the latest news about India?", ["web_search", "open_app_screen", "show_news", "get_news"]],
  // A reminder IS a call at that time, so either tool keeps the promise.
  ["Call me at 8 and remind me to go to college", ["schedule_task", "create_reminder"]],
  ["No, thank you. That's all.", ["end_conversation"]],
  ["What's the weather like today?", ["get_weather"]],
  ["Set an alarm for 5:30 tomorrow morning", ["set_alarm"]],
  ["Set a timer for 10 minutes", ["set_timer"]],
  ["Play some Ilaiyaraaja songs", ["play_music"]],
  ["Any missed calls today?", ["phone_calls"]],
  ["Send a message to Ravi that I'll be late", ["send_agent_message"]],
  ["WhatsApp amma that I reached safely", ["send_whatsapp_message"]],
  ["Add milk and eggs to my shopping list", ["shopping_list_add"]],
  ["What's on my shopping list?", ["shopping_list_show"]],
  ["Turn on the flashlight", ["phone_control"]],
  ["Remember that my car number is KA 01 AB 1234", ["remember_fact"]],
  ["What's my car number?", ["recall_memory"]],
  // Both tools answer "did you call X?" by their own description (2026-10-06).
  ["Did you call Ravi?", ["check_recent_actions", "check_task_outcomes"]],
  ["Open the news", ["open_app_screen"]],
  ["Prepare me for my meeting with Suresh tomorrow", ["prepare_meeting"]],
  // 2026-10-02: posters are generated outright; the studio only on request.
  ["Make a poster for our Diwali party on Friday at 7 pm", ["generate_image", "create_event_poster"]],
  ["Write a short speech for my sister's wedding", ["present_text"]],
  ["Make me a PPT on solar energy", ["create_document"]],
  ["Who is Devi Shetty?", ["web_search"]],
  ["Make my photo look better", ["edit_my_photo"]],
  ["Speak to me in Kannada.", []],
  // Half a sentence: nothing, or stay_silent, both keep quiet.
  ["Tell me the", ["stay_silent"]],
  // The situation sets the manner (2026-10-01): a dues call must carry a
  // tone, a plain message must not (agents/callTone.js fills the rest).
  ["Call Suresh and tell him his EMI is ten days overdue and must be paid by Friday", ["place_phone_call"], { tone: /firm|stern|serious|strict/i }],
  ["Call Ravi and wish him a happy birthday from me", ["place_phone_call"], { tone: /warm|happy|cheer|joy/i }],
];

module.exports = CASES;
