"""Fixed business facts and controlled vocabularies.

Everything customer-facing that states a price or a service pulls from here, so a
price change is made in exactly one place.
"""

BUSINESS_NAME = "Carbon Force Detailing"
CITY = "Melrose Park, IL"

# Confirmed services only. Do not add paint correction, polishing, ceramic coating,
# extraction or mobile service here until the owner actually offers them.
SERVICES = {
    "interior": {"label": "Interior detail", "price": 80},
    "exterior": {"label": "Exterior cleaning", "price": 60},
    "full": {"label": "Full interior + exterior package", "price": 140},
}
SERVICE_CHOICES = list(SERVICES) + ["unsure"]

# Phrases that must never appear in approved customer-facing copy.
BANNED_CLAIMS = [
    "mobile",
    "we come to you",
    "i come to you",
    "at your home",
    "at your location",
    "ceramic",
    "paint correction",
    "polish",
    "buffing",
    "extraction",
    "shampoo extract",
    "fully booked",
    "booked solid",
    "only 1 spot",
    "only one spot",
    "spots left",
    "limited spots",
    "certified",
    "insured",
    "#1",
    "best in",
]

LEAD_STATUSES = [
    "New Lead",
    "Replied",
    "Quote Sent",
    "Follow-Up Due",
    "Booked",
    "Completed",
    "Lost",
]
OPEN_LEAD_STATUSES = ["New Lead", "Replied", "Quote Sent", "Follow-Up Due"]

LEAD_SOURCES = [
    "facebook_page",
    "facebook_group",
    "facebook_marketplace",
    "instagram",
    "google_business_profile",
    "google_search",
    "flyer",
    "referral",
    "repeat_customer",
    "partner",
    "nextdoor",
    "walk_by_or_sign",
    "other",
]

CONTACT_METHODS = ["text", "call", "facebook_messenger", "instagram_dm", "email", "in_person", "other"]

POST_STATUSES = ["draft", "approved", "scheduled", "published"]

APPOINTMENT_STATUSES = ["proposed", "confirmed", "completed", "cancelled", "no_show"]
SLOT_STATUSES = ["open", "held", "booked", "closed"]
PAYMENT_STATUSES = ["unpaid", "partial", "paid", "refunded"]
PAYMENT_METHODS = ["cash", "zelle", "venmo", "cash_app", "card", "other"]

OPPORTUNITY_TYPES = [
    "facebook_group",
    "facebook_page",
    "google_business_profile",
    "local_search",
    "partnership",
    "directory",
    "referral_program",
    "community_event",
    "other",
]
OPPORTUNITY_STATUSES = [
    "to_research",
    "researched",
    "join_requested",
    "joined",
    "contacted",
    "posted",
    "active_partner",
    "no_response",
    "declined",
    "not_a_fit",
]

# How a group treats business posts. Picks which community-group draft to use.
GROUP_RULE_TYPES = {
    "promo_allowed": "Business posts allowed any day (still keep it neighborly)",
    "promo_day_only": "Business posts only on a set promo day/thread",
    "recommendations_only": "No ads; you may answer when someone asks for a recommendation",
    "no_business": "No business posts at all - do not post, just be a member",
    "unknown": "Rules not checked yet - read the rules before posting anything",
}

EFFORT_CHANNELS = LEAD_SOURCES

# Settings the owner fills in once. Copy with an unset required setting cannot be
# approved, so placeholders never leak into a real post.
SETTINGS_FIELDS = {
    "booking_line": ("How customers book", "Text or call 708-555-0000 to book", True),
    "phone": ("Business phone (for templates)", "708-555-0000", True),
    "area_line": ("Public location wording (no street address)", "Melrose Park, near North Ave & 25th", True),
    "hours_line": ("Drop-off hours you actually keep", "Drop-off Mon-Sat, 8-10am", True),
    "owner_first_name": ("Your first name for messages (optional)", "", False),
    "payment_methods": ("Payment you accept", "Cash, Zelle", True),
    "interior_includes": ("What the $80 interior actually includes", "vacuum seats/carpet/trunk, wipe down dash, console, door panels, cup holders, inside glass", True),
    "exterior_includes": ("What the $60 exterior actually includes", "hand wash, wheels and tires, dry, outside glass", True),
    "turnaround_line": ("Honest turnaround wording", "Drop off in the morning, I text you when it's ready", True),
    "private_address": ("Exact drop-off address (only used in booking confirmations)", "", False),
    "review_link": ("Review link (Google or Facebook) once you have one", "", False),
    "max_jobs_per_day": ("Max cars you can do in one day", "2", True),
    "launch_date": ("Day 1 of your 7-day plan (YYYY-MM-DD)", "", False),
    "cash_mode": ("Cash mode on? (yes/no)", "no", False),
}
