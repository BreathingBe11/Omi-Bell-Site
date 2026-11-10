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

const SITE_CONTENT = [
  // key, default, label, group, multiline
  ['hero.eyebrow', 'SMOOTH OPERATORS · LIVE 21-DAY COHORT', 'Hero eyebrow', 'Landing: hero'],
  ['hero.headline', 'You’ve built a business. Now stop being what holds it together.', 'Hero headline', 'Landing: hero'],
  ['hero.body', 'Your next stage of growth needs clear leadership, repeatable systems, and people who can move the work forward without waiting on you. Build that foundation in Smooth Operators—a live, guided 21-day cohort for founders ready to grow beyond doing everything themselves.', 'Hero supporting copy', 'Landing: hero', true],
  ['hero.promise', 'Build the leadership, systems, and accountability your next stage of growth requires—in 21 days, with guidance at every step.', 'Primary explanatory promise', 'Landing: hero', true],
  ['problem.headline', 'You want to grow. But look at what growth currently asks of you.', 'Growth problem headline', 'Landing: problem'],
  ['problem.body', 'More customers mean more follow-up. More work means more decisions. Hiring help means explaining everything—and checking it afterward.\n\nYou’re bringing in business. You’re also approving, answering, remembering, fixing, and keeping things moving. If every new opportunity requires more of your time, your growth has a limit.', 'Growth problem copy', 'Landing: problem', true],
  ['problem.transition', 'It’s time to change how the business runs.', 'Transition line', 'Landing: problem'],
  ['method.headline', 'From carrying the business to leading the company.', 'Method headline', 'Landing: method'],
  ['method.standards', 'Lead with clarity. Define values, leadership philosophy, expectations, and decision rights.', 'Standards description', 'Landing: method', true],
  ['method.systems', 'Make the work repeatable. Document a priority workflow, clarify responsibility, and create a practical handoff.', 'Systems description', 'Landing: method', true],
  ['method.scorecards', 'Give growth direction. Set a 90-day goal, choose meaningful measures, and establish a review rhythm.', 'Scorecards description', 'Landing: method', true],
  ['days.headline', 'Every day, move something out of your head and into your business.', '21 days headline', 'Landing: daily rhythm'],
  ['days.body', 'Each day follows the same short rhythm: a guided breathing or meditation practice to arrive, one focused business question to reflect on, one practical action to apply, and the template that helps you do it. Some days introduce new work; others test and refine what you started.', 'Daily rhythm copy', 'Landing: daily rhythm', true],
  ['days.calls', 'During the cohort, live Solutions Seat sessions give you a place to bring an operational challenge you’re working through. The group thinks it through together. How much individual time each person gets depends on attendance, so bring the question that matters most.', 'Solutions Seat explanation', 'Landing: daily rhythm', true],
  ['days.promise', 'Every day, make one clearer decision. Every week, put another operating foundation in place.', 'Daily experience promise', 'Landing: daily rhythm'],
  ['outcomes.headline', 'What you’ll build', 'Outcomes headline', 'Landing: outcomes'],
  ['outcomes.list', 'A “How We Work” guide: your internal leadership and operating expectations (not an LLC legal operating agreement).\nOne priority workflow, documented, tested, and refined.\nClearer roles, handoffs, and decision boundaries.\nAn agreement checklist and the business terms to prepare for appropriate contract review.\nA 90-day goal and a practical KPI scorecard.\nA repeatable weekly business review agenda.', 'Outcomes (one per line)', 'Landing: outcomes', true],
  ['outcomes.note', 'This is your first operating foundation, not a promise that the business runs without you in 21 days. Contract-related resources are business tools and drafts, not legal advice or a substitute for review by a qualified attorney.', 'Outcomes scope note', 'Landing: outcomes', true],
  ['fit.headline', 'Who it’s for', 'Fit headline', 'Landing: fit'],
  ['fit.body', 'Smooth Operators is for founders with customers and revenue who need an operating foundation for delegation and growth. Solo founders preparing for a first hire and founders already leading a small team can both participate.\n\nYou’ll get the most from it if you set aside time each day to do the implementation work, not just read about it.', 'Fit copy', 'Landing: fit', true],
  ['fit.time_commitment', '', 'Specific time commitment (owner to confirm)', 'Landing: fit'],
  ['about.headline', 'About Omi Bell', 'About headline', 'Landing: about'],
  ['about.bio', 'Omi Bell is the Founder and CEO of Black Girl Ventures and a strategist and wellness practitioner whose work brings together business-building and deliberate leadership.', 'Approved bio', 'Landing: about', true],
  ['about.credentials', '', 'Approved credentials / verified examples (one per line)', 'Landing: about', true],
  ['about.photo_url', '', 'Approved photo URL (https or /images/...)', 'Landing: about'],
  ['about.photo_alt', 'Omi Bell', 'Photo description', 'Landing: about'],
  ['enroll.headline', 'Join the cohort', 'Enrollment headline', 'Landing: enrollment'],
  ['enroll.includes', 'A daily business reflection and practical action\nToolkit templates for the work\nGuided breathwork and meditation practices\nLive Solutions Seat calls\nA private journal that keeps your reflections in one place', 'What’s included (one per line)', 'Landing: enrollment', true],
  ['enroll.footer_cta_note', 'One-time payment. Live cohort; everyone follows the same 21-day calendar.', 'Footer CTA note', 'Landing: enrollment'],
  ['purchase.refund_policy', 'After you enroll, our team reviews your fit check. If we decide Smooth Operators isn’t the right fit for where your business is right now, we’ll refund your payment in full. Once you’re approved, your enrollment is non-refundable.', 'Refund policy (publish before live sales)', 'Purchase & legal', true],
  ['purchase.access_terms', '', 'Access duration statement (required before live sales)', 'Purchase & legal', true],
  ['purchase.tax_treatment', '', 'Tax treatment statement (required before live sales)', 'Purchase & legal', true],
  ['purchase.disclosure', '', 'Additional purchase disclosure shown at checkout', 'Purchase & legal', true],
  ['calls.recording_policy', '', 'Call recording & replay policy (required before live sales)', 'Purchase & legal', true],
  ['legal.terms', '', 'Terms of purchase / use (full text)', 'Purchase & legal', true],
  ['legal.privacy', '', 'Privacy policy (full text)', 'Purchase & legal', true],
  ['support.email', '', 'Support email address', 'Support'],
  ['support.note', '', 'Support expectations (e.g. response time)', 'Support', true],
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
  ['Where the business depends on you', 'What stops moving when you step away?', 'Identify one founder-dependent operational bottleneck.'],
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

// Suggested FAQs. Answers drafted only where the brief states the product fact;
// everything is seeded as DRAFT and needs owner approval before it is published.
const FAQ_SEED = [
  ['Is this for solo founders?', 'Yes. Solo founders preparing for a first hire and founders already leading a small team can both participate.'],
  ['Do I need employees?', 'No. If you work alone today, you’ll build the expectations, workflow, and handoffs you need before you bring someone in.'],
  ['What happens each day?', 'Each day opens with a short guided practice, one focused business question, and one practical action, with a related template when one applies. Days unlock on the shared cohort calendar.'],
  ['What if I miss a day?', 'Earlier days stay available. There is no forced order and you won’t lose progress; pick up where it makes sense for your business.'],
  ['How do Solutions Seat calls work?', 'Bring an operational challenge you’re working through and the group thinks it through together. Individual time depends on attendance, so not every person is guaranteed a personal hot seat on every call.'],
  ['Are calls recorded?', ''],
  ['How long do I retain access?', ''],
  ['What is the refund policy?', ''],
  ['Are contracts legally reviewed?', ''],
];

module.exports = { SITE_CONTENT, SITE_CONTENT_KEYS, PILLARS, WEEKS, PROVISIONAL_DAYS, FAQ_SEED };
