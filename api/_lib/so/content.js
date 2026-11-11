'use strict';
// Default copy and provisional curriculum for Smooth Operators.
//
// Landing copy below comes from the owner's build brief and is used until an
// admin publishes an override in so_site_content. Keys with an empty default
// (bio extras, refund terms, time commitment...) are owner inputs: nothing is
// rendered for them until the owner writes and publishes the text.
//
// The 21-day curriculum is PROVISIONAL draft material from the brief. It is
// seeded as draft + is_sample so it can be previewed but is never shown to
// members until an admin reviews and publishes each day.

const LEGAL = require('./legal');

const SITE_CONTENT = [
  // key, default, label, group, multiline
  ['hero.eyebrow', 'SMOOTH OPERATORS · LIVE 21-DAY COHORT', 'Hero eyebrow', 'Landing: hero'],
  ['hero.headline', 'Your business is growing. Your room to breathe keeps shrinking.', 'Hero headline', 'Landing: hero'],
  ['hero.body', 'You built a business to create freedom. So why does everything still depend on you? Smooth Operators is a 21-day live cohort for business owners in the in-between: build the systems your company needs, and do the inner work that lets you finally let go.', 'Hero supporting copy', 'Landing: hero', true],
  ['hero.promise', 'Build the leadership, systems, and accountability your next stage of growth requires—in 21 days, with guidance at every step.', 'Primary explanatory promise', 'Landing: hero', true],
  ['hero.photo_url', '', 'Photo of Omi near the opening (https or /images/...). Leave empty to hide.', 'Landing: hero'],
  ['hero.photo_alt', 'Omi Bell', 'Opening photo description', 'Landing: hero'],
  ['video.url', '', 'Intro video link (YouTube, Vimeo, or an .mp4 URL). Leave empty to hide the section.', 'Landing: video'],
  ['video.headline', 'Why I created Smooth Operators', 'Video headline', 'Landing: video'],
  ['video.caption', '', 'Short text under the video (optional)', 'Landing: video', true],
  ['problem.headline', 'You want to grow. But look at what growth currently asks of you.', 'Growth problem headline', 'Landing: problem'],
  ['problem.body', 'More customers mean more follow-up. More work means more decisions. Hiring help means explaining everything—and checking it afterward.\n\nYou’re bringing in business. You’re also approving, answering, remembering, fixing, and keeping things moving. If every new opportunity requires more of your time, your growth has a limit.', 'Growth problem copy', 'Landing: problem', true],
  ['problem.transition', 'It’s time to change how the business runs.', 'Transition line', 'Landing: problem'],
  ['method.headline', 'From carrying the business to leading the company.', 'Method headline', 'Landing: method'],
  ['method.standards', 'Lead with clarity. Define values, leadership philosophy, expectations, and decision rights.', 'Standards description', 'Landing: method', true],
  ['method.systems', 'Make the work repeatable. Document a priority workflow, clarify responsibility, and create a practical handoff.', 'Systems description', 'Landing: method', true],
  ['method.scorecards', 'Give growth direction. Set a 90-day goal, choose meaningful measures, and establish a review rhythm.', 'Scorecards description', 'Landing: method', true],
  ['days.headline', 'How it works', '21 days headline', 'Landing: daily rhythm'],
  ['days.body', 'Each day, a new guided audio, leadership journal prompt, and Business Action Toolkit resource unlock inside your platform. Take time to arrive, reflect on how you lead, and apply one practical change to your business. New content unlocks every day, including weekends.\n\nEvery day builds on the Standards, Systems, and Scorecards framework. Some activities introduce new work; others help you test, refine, or continue what you’ve already built.', 'Daily rhythm copy', 'Landing: daily rhythm', true],
  ['days.calls', 'Solutions Seat is group coaching led by Omi Bell. A participant brings a business challenge they’re working through that week, the group contributes ideas and experience, and Omi guides the conversation toward practical next steps. You can learn by bringing your own challenge, contributing to someone else’s, and applying the discussion to your business.', 'Solutions Seat explanation', 'Landing: daily rhythm', true],
  ['days.time', 'Plan for 5–10 minutes of guided audio and approximately 20–40 minutes to apply the day’s work to your business. Some implementation activities may take up to an hour. Lighter activities may take about 20 minutes to reflect, test what you’ve built, or catch up. Live calls are additional to the daily work.', 'Daily time commitment', 'Landing: daily rhythm', true],
  ['days.calls_schedule', 'Three live calls with Omi Bell on Wednesdays, January 6, 13, and 20, 2027, from 1–2 p.m. PST. Each call is one hour. Recordings are available inside the platform.', 'Live call schedule', 'Landing: daily rhythm', true],
  ['days.support', 'Inside the platform, you can submit questions and chat back and forth with Omi in the support area. During the 21-day cohort, Omi responds within 24 hours, Monday through Friday. Questions sent over the weekend receive a response by the end of Monday.', 'Direct support from Omi', 'Landing: daily rhythm', true],
  ['access.summary', 'Daily guided programming: January 4–24, 2027\nDirect Q&A support from Omi: during the 21-day cohort, Monday through Friday\nProgram materials and call recordings: 12 months, January 4, 2027 through January 3, 2028', 'What’s included and for how long (one per line, "Label: detail")', 'Landing: daily rhythm', true],
  ['days.promise', 'Every day, make one clearer decision. Every week, put another operating foundation in place.', 'Daily experience promise', 'Landing: daily rhythm'],
  ['outcomes.headline', 'What you’ll build', 'Outcomes headline', 'Landing: outcomes'],
  ['outcomes.list', 'A “How We Work” guide: your internal leadership and operating expectations (not an LLC legal operating agreement).\nOne priority workflow, documented, tested, and refined.\nClearer roles, handoffs, and decision boundaries.\nAn agreement checklist and the business terms to prepare for appropriate contract review.\nA 90-day goal and a practical KPI scorecard.\nA repeatable weekly business review agenda.', 'Outcomes (one per line)', 'Landing: outcomes', true],
  ['outcomes.note', 'This is your first operating foundation, not a promise that the business runs without you in 21 days. Contract-related resources are business tools and drafts, not legal advice or a substitute for review by a qualified attorney.', 'Outcomes scope note', 'Landing: outcomes', true],
  ['fit.headline', 'Who it’s for', 'Fit headline', 'Landing: fit'],
  ['fit.body', 'Smooth Operators is for business owners with customers and revenue who want clearer leadership, stronger systems, and a practical foundation for delegation and growth. It’s designed for people ready to work on both how their business operates and how they lead it.\n\nYou can participate as a solo business owner. The program is especially useful if you’re considering hiring contractors or employees within the next 12–24 months and want to prepare your business to share the work.', 'Fit copy', 'Landing: fit', true],
  ['fit.time_commitment', 'Plan for 5–10 minutes of guided audio and approximately 20–40 minutes to apply the day’s work to your business. Some implementation activities may take up to an hour. Lighter activities may take about 20 minutes to reflect, test what you’ve built, or catch up.', 'Specific time commitment (owner to confirm)', 'Landing: fit'],
  ['about.headline', 'About Omi Bell', 'About headline', 'Landing: about'],
  ['about.bio', 'Omi Bell is an entrepreneur, storyteller, and energy healer whose work spans business leadership, cultural influence, and personal transformation.\n\nAs Founder and CEO of Black Girl Ventures, she has earned recognition among Entrepreneur magazine’s 100 Powerful Women in Business, as an Adweek Rising Brand Star, and as Technical.ly DC’s Entrepreneur of the Year. One of Google’s eight original Digital Coaches, she has trained more than 5,000 entrepreneurs, testified before Congress, rung the Nasdaq closing bell, and appeared on a Nike billboard.\n\nAn Aspen Ideas Fellow and Kennedy Center artist, Omi brings that same depth of leadership to breathwork, sound healing, and Reiki. She has served more than 1,500 people through breathwork and sound healing.\n\nNow, through Smooth Operators, she brings these worlds together in a 21-day reset for the body and the business, rooted in her signature focus: body, business, and belonging.', 'Approved bio', 'Landing: about', true],
  ['about.credentials', '', 'Approved credentials / verified examples (one per line)', 'Landing: about', true],
  ['about.photo_url', '', 'Approved photo URL (https or /images/...)', 'Landing: about'],
  ['about.photo_alt', 'Omi Bell', 'Photo description', 'Landing: about'],
  ['testimonial.1.quote', '', 'Testimonial 1: quote (only supplied, verified testimonials)', 'Landing: testimonials', true],
  ['testimonial.1.name', '', 'Testimonial 1: name', 'Landing: testimonials'],
  ['testimonial.1.context', '', 'Testimonial 1: context (e.g. "Advising client", "Breathwork participant")', 'Landing: testimonials'],
  ['testimonial.2.quote', '', 'Testimonial 2: quote', 'Landing: testimonials', true],
  ['testimonial.2.name', '', 'Testimonial 2: name', 'Landing: testimonials'],
  ['testimonial.2.context', '', 'Testimonial 2: context', 'Landing: testimonials'],
  ['testimonial.3.quote', '', 'Testimonial 3: quote', 'Landing: testimonials', true],
  ['testimonial.3.name', '', 'Testimonial 3: name', 'Landing: testimonials'],
  ['testimonial.3.context', '', 'Testimonial 3: context', 'Landing: testimonials'],
  ['enroll.headline', 'Join the cohort', 'Enrollment headline', 'Landing: enrollment'],
  ['enroll.includes', 'A new guided audio every day: breathwork, meditation, or sound healing\nA daily Leadership Journal Prompt\nA daily Business Action Toolkit resource: a practical template or tool, with instructions\nThree live Solutions Seat group coaching calls with Omi Bell\nDirect Q&A with Omi in the platform during the 21-day cohort\n12 months of access to program materials and call recordings', 'What’s included (one per line)', 'Landing: enrollment', true],
  ['enroll.footer_cta_note', 'One-time payment. Live cohort; everyone follows the same 21-day calendar.', 'Footer CTA note', 'Landing: enrollment'],
  ['perks.session_discount', '', 'Participant discount on further sessions with Omi (owner to define amount, sessions and expiry; hidden until published)', 'Landing: enrollment', true],
  ['purchase.refund_policy', 'You may request a full refund before the cohort begins on January 4, 2027. Once the cohort begins on January 4, all sales are final and no refunds are available. To request a refund before the start date, email hello@omisworld.com.', 'Refund policy summary shown at checkout (publish before live sales)', 'Purchase & legal', true],
  ['purchase.refund_timing', 'Depending on your bank, refunds usually appear within 5–10 business days.', 'Refund timing sentence used in refund emails (owner to approve)', 'Purchase & legal'],
  ['purchase.access_terms', 'You receive 12 months of access to program materials and call recordings, from January 4, 2027 through January 3, 2028. Daily guided programming runs January 4–24, 2027. Direct Q&A support from Omi is available during the 21-day cohort, Monday through Friday.', 'Access duration statement (required before live sales)', 'Purchase & legal', true],
  ['purchase.tax_treatment', '', 'Tax treatment statement (required before live sales)', 'Purchase & legal', true],
  ['purchase.disclosure', '', 'Additional purchase disclosure shown at checkout', 'Purchase & legal', true],
  ['calls.recording_policy', 'Live calls are recorded. Recordings are available inside the platform for your 12-month access period.', 'Call recording & replay policy (required before live sales)', 'Purchase & legal', true],
  ['legal.terms', LEGAL.TERMS, 'Terms of purchase / use (full text; "## " = heading, "- " = bullet)', 'Purchase & legal', true],
  ['legal.privacy', LEGAL.PRIVACY, 'Privacy policy (full text; "## " = heading, "- " = bullet)', 'Purchase & legal', true],
  ['support.email', 'hello@omisworld.com', 'Support email address', 'Support'],
  ['support.note', 'Inside the platform, you can submit questions and chat back and forth with Omi in the support area. During the 21-day cohort, Omi responds within 24 hours, Monday through Friday. Questions sent over the weekend receive a response by the end of Monday.', 'Support expectations (e.g. response time)', 'Support', true],
].map(([key, def, label, group, multiline]) => ({ key, default: def, label, group, multiline: !!multiline }));

const SITE_CONTENT_KEYS = new Set(SITE_CONTENT.map(c => c.key));

const PILLARS = {
  standards:  { label: 'Standards',  week: 1 },
  systems:    { label: 'Systems',    week: 2 },
  scorecards: { label: 'Scorecards', week: 3 },
};

const WEEKS = [
  { week_number: 1, pillar: 'standards',  title: 'Standards: Lead with clarity',       assignment: 'Apply and refine your How We Work guide.' },
  { week_number: 2, pillar: 'systems',    title: 'Systems: Make the work repeatable',   assignment: 'Test and revise one priority workflow.' },
  { week_number: 3, pillar: 'scorecards', title: 'Scorecards: Give growth direction',  assignment: 'Run your first owner/business review meeting.' },
];

// [title, reflection, action]
const PROVISIONAL_DAYS = [
  ['Where the business depends on you', 'What stops moving when you step away?', 'Identify one owner-dependent operational bottleneck.'],
  ['Values as behavior', 'What should people consistently experience when working with your company?', 'Translate three core values into observable behaviors.'],
  ['Leadership philosophy', 'What can people count on you for—and what do you expect in return?', 'Draft your leadership commitments.'],
  ['Decision rights', 'What decisions return to you because the boundaries are unclear?', 'Define one decision owner, boundaries, and escalation point.'],
  ['Working expectations', 'What do you expect people to know that you have never clearly explained?', 'Document communication and working expectations.'],
  ['Test your standards', 'What would your values ask you to do when a deadline is missed?', 'Apply standards to a real customer, deadline, or disagreement scenario.'],
  ['How We Work', 'Where does your stated leadership differ from the experience people have?', 'Consolidate and revise the week’s How We Work guide.'],
  ['Choose the workflow', 'What have you explained more than twice this month?', 'Select one recurring workflow to document.'],
  ['Map the work', 'Where does this process actually begin and end?', 'Map its trigger, steps, handoffs, and outcome.'],
  ['Define good work', 'How would someone know this task was done well?', 'Add quality standards and a completion checklist.'],
  ['Clarify ownership', 'Who owns the outcome, rather than just a piece of the task?', 'Define roles, access requirements, and handoff points.'],
  ['Clarify agreements', 'What expectations are being left to assumption?', 'Identify business terms and agreements needing review.'],
  ['Test the handoff', 'Where would another person get stuck following your instructions?', 'Walk through or test the SOP and capture gaps.'],
  ['Refine the system', 'What still requires you that could be clarified in the process?', 'Revise the workflow and choose a practical delegation step.'],
  ['Choose the next goal', 'What would make the next 90 days meaningfully better for this business?', 'Choose one specific 90-day business goal.'],
  ['Choose useful measures', 'What number would reveal trouble before a customer complains?', 'Select a small set of relevant KPIs.'],
  ['Establish the baseline', 'What do you know from data, and what are you assuming?', 'Record available baselines and realistic targets.'],
  ['Assign accountability', 'What keeps being discussed without anyone owning the next step?', 'Assign each measure/action an owner and review date.'],
  ['Build the meeting rhythm', 'Which conversations need a reliable place on the calendar?', 'Create a weekly business review agenda and cadence.'],
  ['Run the review', 'What decision do these numbers ask you to make?', 'Run a review using actual available data and capture actions.'],
  ['Keep it operating', 'What will keep these practices alive after the cohort ends?', 'Finalize the 90-day operating rhythm and next review date.'],
];

// The FAQ. One shared source: seeded into so_faqs as published, audience
// "both", so the landing page and the member platform always show the same
// questions and answers (edit them in admin -> Solutions Seat / FAQs).
const FAQ_SEED = [
  ['Who is Smooth Operators for?', 'Smooth Operators is for business owners with customers and revenue who want clearer leadership, stronger systems, and a practical foundation for delegation and growth. It’s designed for people ready to work on both how their business operates and how they lead it.'],
  ['Can I participate if I don’t have employees yet?', 'Yes. You can participate as a solo business owner. The program is especially useful if you’re considering hiring contractors or employees within the next 12–24 months and want to prepare your business to share the work.'],
  ['What happens each day? Does content unlock on weekends?', 'Each day, you receive a new guided breathwork, meditation, or sound healing audio; a leadership journal prompt; and a Business Action Toolkit resource with a practical template or tool to apply to your business. Content unlocks every day for 21 days, including weekends.'],
  ['How much time should I set aside?', 'Plan for 5–10 minutes of guided audio and approximately 20–40 minutes to apply the day’s work. Some implementation activities may take up to an hour. Lighter activities may take about 20 minutes to reflect, test what you’ve built, or catch up. The three live coaching calls are one hour each and are additional to the daily work.'],
  ['When are the live calls?', 'Live calls take place on Wednesdays, January 6, 13, and 20, 2027, from 1–2 p.m. PST. Omi Bell leads all three calls. Recordings are available inside the platform.'],
  ['What is a Solutions Seat?', 'Solutions Seat is group coaching led by Omi Bell. A participant brings a business challenge they’re working through that week, the group contributes ideas and experience, and Omi guides the conversation toward practical next steps. You can learn by bringing your own challenge, contributing to someone else’s, and applying the discussion to your business.'],
  ['What if I cannot attend live?', 'You can watch the call recordings inside the platform. You can also submit your questions through the support area during the 21-day cohort.'],
  ['How do I ask Omi questions?', 'Inside the Smooth Operators platform, there is a support area where you can submit questions and chat back and forth with Omi. During the 21-day cohort, Omi responds within 24 hours, Monday through Friday. Weekend questions receive a response by the end of Monday.'],
  ['How long do I keep access?', 'You receive 12 months of access to program materials and call recordings beginning January 4, 2027. Direct Q&A support from Omi is available during the 21-day cohort.'],
  ['Do I need meditation or breathwork experience?', 'No previous experience is required. Follow the guided audios at your own pace and adapt your participation to your comfort.'],
  ['Is any particular spiritual belief required?', 'No. You do not need to follow any particular spiritual belief. The guided practices give you space to pause, reflect, and engage with the work.'],
  ['What is the refund policy?', 'You may request a full refund before the cohort begins on January 4, 2027. Once the cohort begins on January 4, all sales are final and no refunds are available. To request a refund before the start date, email hello@omisworld.com.'],
];

// Earlier draft FAQ questions, removed by the v3 migration.
const RETIRED_FAQS = ['Is this for solo founders?', 'Do I need employees?', 'What happens each day?', 'What if I miss a day?',
  'How do Solutions Seat calls work?', 'Are calls recorded?', 'How long do I retain access?', 'What is the refund policy?', 'Are contracts legally reviewed?'];

// Owner-confirmed wording published by the v3 migration so every surface agrees.
const CONFIRMED_KEYS = ['hero.headline', 'hero.body', 'days.headline', 'days.body', 'days.calls', 'days.time', 'days.calls_schedule', 'days.support',
  'access.summary', 'fit.body', 'fit.time_commitment', 'enroll.includes', 'purchase.refund_policy', 'purchase.access_terms',
  'calls.recording_policy', 'support.note', 'legal.terms', 'legal.privacy'];

module.exports = { SITE_CONTENT, SITE_CONTENT_KEYS, PILLARS, WEEKS, PROVISIONAL_DAYS, FAQ_SEED, RETIRED_FAQS, CONFIRMED_KEYS };
