# Pre-launch compliance review checklist

> **This is not legal advice.** It is a list of questions to work through with an
> Ontario lawyer *before* real players use the member area. Building a website, or
> keeping records carefully, does not make the underlying poker game lawful. Review the
> answers again whenever the game, fees, promotions or hosting arrangements change.

## A. The game itself (Criminal Code, Part VII)

The Criminal Code makes it an offence to keep a **common gaming house**, and people
*found in* one can also be charged. Under s. 197 a place can be a common gaming house if,
among other things, it is **kept for gain**, if any portion of the bets or proceeds goes
to the **keeper**, or if a **fee** is charged to players for the privilege of playing or
using gaming equipment, directly or indirectly. “Keeper” is defined broadly: owners,
occupiers, people managing the place, and people who help them.

- [ ] **Confirm the current text of s. 197.** The federal Justice Laws site lists the
      2019 version of s. 197 as in force only until 2026-09-21, which suggests it was
      amended recently. Have your lawyer confirm what applies now.
- [ ] **No rake, seat fee, table fee, membership fee or “drop”.** Confirm in writing how
      the game is run. Any money retained by the host or anyone helping, directly or
      indirectly, is the central risk.
- [ ] **High-hand and jackpot promotions.** Where does the prize money come from? If any
      of it is taken from pots or from players’ buy-ins, it may count as proceeds paid to
      the keeper. Get specific advice before running promotions.
- [ ] **Complimentary food and non-alcoholic drinks.** Confirm they are paid for by the
      host personally and are not funded by players directly or indirectly (e.g. from a
      drop or a “tip” jar tied to play).
- [ ] **Dealers or helpers.** If anyone is paid, or tipped from the game, ask how that
      affects “kept for gain” and “keeper”.
- [ ] **The member area creates records.** Session results, buy-ins and the permanent
      audit log are written evidence of how the game operates. Make sure what they would
      show is consistent with a lawful game, and decide on a retention period.
- [ ] **Adjustments field.** It is designed to record money that didn’t go back to
      players. If you find yourself recording house money there, stop and get advice.
- [ ] **Age.** Confirm the minimum age you will enforce (the age of majority in Ontario
      is 19) and how you check it. The site doesn’t verify age.
- [ ] **Location privacy.** The address is never published, and is shared privately with
      confirmed players. Confirm this is consistent with any landlord, condo or insurance
      obligations at the venue.

## B. Online gaming and payments

- [ ] **No online wagering.** The site takes no deposits, bets or payments and offers no
      online play. In Ontario, online gaming is offered only by operators registered with
      the AGCO under an operating agreement with iGaming Ontario. Keep it that way.
- [ ] **No payment features.** Mainstream payment processors prohibit gambling-related
      payments in their terms. Don’t add payment links, invoices or balances to the site.
- [ ] Results shown on the dashboard are a personal record only. Confirm with your lawyer
      that showing players their own results raises no issues.

## C. Alcohol (BYOB)

- [ ] The site states the hosts **never serve alcohol** and it is **BYOB**. Confirm with
      your lawyer that this arrangement is consistent with Ontario’s liquor laws for a
      private residence, and that no one sells alcohol or charges for it in any form.
- [ ] Consider host liability (guests who drink). Ask about insurance.

## D. Privacy (PIPEDA and good practice)

PIPEDA applies to personal information collected, used or disclosed **in the course of
commercial activities**. Whether a private home game is “commercial” is a question for
your lawyer. Either way, the site is built to follow PIPEDA’s fair information principles.

- [ ] **Applicability:** ask whether PIPEDA applies to this activity. If unsure, act as if
      it does.
- [ ] **Accountability:** name the person responsible for privacy (the host) and how to
      reach them. The privacy notice says to message @akcashclub on Instagram. Consider
      also listing an email address once you have a domain.
- [ ] **Consent:** tracking is opt-in, explained before consent, revocable, and audited. ✓
- [ ] **Limiting collection:** only email, username, consent and results are collected. ✓
- [ ] **Access and correction:** process in `docs/DATA_REQUESTS.md`, 30-day target. ✓
- [ ] **Retention:** decide how long session records are kept (e.g. delete sessions older
      than N years). Not yet automated.
- [ ] **Safeguards:** RLS, MFA for the host, HttpOnly cookies, rate limits, audit log. ✓
      Use a password manager and MFA on your Supabase, Cloudflare, Resend and GitHub
      accounts too.
- [ ] **Cross-border storage:** choose the Supabase **Canada (Central)** region. Cloudflare
      and Resend may process data outside Canada; the privacy notice says this. Confirm
      the wording with your lawyer.
- [ ] **Breaches:** know what to do if an account is compromised: who to tell, and when.
      PIPEDA has mandatory breach reporting and record-keeping where it applies.
- [ ] **Privacy notice:** review `/privacy` (src/pages/privacy.astro) with your lawyer.

## E. Email (CASL)

Account emails (verify, reset, email change) are transactional. Under CASL, certain
transactional messages are exempt from the *consent* requirement, but commentators and
the CRTC have indicated they may still need *sender identification* and an *unsubscribe
mechanism* if they count as commercial electronic messages.

- [ ] Confirm whether the account emails are commercial electronic messages at all, and
      if so what identification is required (the templates include the club name, city
      and website).
- [ ] Never add promotions or marketing to account emails without proper consent.

## F. Platform terms

- [ ] Read the acceptable-use terms of **Supabase**, **Cloudflare** and **Resend**, and
      confirm a private poker group’s member portal is permitted.
- [ ] Instagram: confirm your account’s content follows Meta’s policies on gambling content.

## G. Before go-live

- [ ] Lawyer review of sections A–E completed, with notes kept.
- [ ] `docs/SETUP.md` completed, including host MFA.
- [ ] Privacy notice and on-site wording updated per the lawyer’s advice.
- [ ] Test accounts and test sessions deleted.
