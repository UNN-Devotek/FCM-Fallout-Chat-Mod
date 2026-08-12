# Fallout Chat Mod — Desktop Client Terms

**Effective date:** 2026-08-06
**Version:** 2.0

These terms govern your installation and use of the Fallout Chat Mod desktop
client and the chat relay service operated at `falloutchatmod.com`
(collectively, the **Service**). The Service is operated by the Fallout Chat Mod project maintainer
(the **Developer**) and made available to the *Fallout 76* community.

**Every feature of the Service is free.** Chat, channels, parties, moderation, the
desktop overlay, and the optional in-game HUD mods are and will remain available at no
charge. An optional paid **Supporter** subscription exists solely to help fund hosting
and development; it unlocks **cosmetic personalisation only** (how your name appears in
chat) and never gates, restricts, or degrades any functional part of the Service. See
§11 for the full terms of that subscription.

References to the **Developer** below mean the project maintainer; their contact
information is published in the project repository.

If you do not agree to these terms, do not install or use the Service.

---

## 1. Relationship to the Fallout 76 EULA

*Fallout 76* is a product of ZeniMax Media and Bethesda Softworks. Your use of
*Fallout 76* is separately governed by their End User License Agreement and
Terms of Service (the **Bethesda EULA**), available at
<https://bethesda.net/data/eula/en.html>.

The Service is a **third-party tool**. It is **not** affiliated with,
endorsed by, sponsored by, or authorized by ZeniMax Media or Bethesda
Softworks. The Developer makes no representation that the Service is
permitted by the Bethesda EULA. **You are responsible for your own
compliance with the Bethesda EULA, including any consequences (such as
account suspension or termination) that may arise from using third-party
tools alongside Fallout 76.**

### 1.1 What the Service does and does not do

The Service:

- Detects whether the `Fallout76.exe` process is running (using a public
  operating-system process-list facility) solely to show or hide the chat
  overlay while you play.
- Sends chat messages you compose to the relay server and broadcasts messages
  from other Service users to your overlay.

The Service does **not**:

- Open the `Fallout76.exe` process;
- Read your `Fallout76.exe` process memory;
- Modify game files, install drivers, or inject code into Fallout 76;
- Detect your character name or nearby players from game memory;
- Detect, infer, or record which Fallout 76 world server you are connected to.

Your Fallout 76 character name is a piece of text that you supply
yourself during onboarding (or in the Settings page). If you don't supply
one, the Service uses your Discord display name in chat instead.

Earlier releases included features that read the Windows TCP connection table
to detect your current Fallout 76 world server (for a per-world "Server" chat),
and — before that (v1.0.18–v1.2.0) — an optional process-memory reader. The
process-memory reader was removed in v1.3.0 to align with Bethesda EULA §4(F)
("any software that reads areas of RAM used by the Game to store information
about a character or the game environment"). The automatic world-server
detection was removed in v1.3.30 because it could not be done reliably without
game-memory access. Neither feature is part of the shipping app.

## 2. Your account and data

To use the Service you log in via Discord OAuth. The Service stores:

- Your Discord ID, username, and display name;
- A Fallout 76 character name that you supply (optional);
- An optional free FCM chat name that you set in your Profile or with Discord `/name`;
- The chat messages you send through the Service.

This data is stored on a server controlled by the Developer and is not sold,
licensed, or shared with any third party except as required by law. Chat
messages are retained for up to 90 days. You may request deletion of
your account and all associated data by opening an issue on the project
repository or by contacting the project maintainer through the contact
information published there.

## 3. Acceptable use

You agree not to use the Service:

- To harass, threaten, defame, or impersonate any person;
- To distribute illegal content;
- To send unsolicited bulk messages, advertising, or commercial
  solicitations;
- To gain or attempt to gain unauthorized access to the Service or to the
  underlying infrastructure;
- To exploit the Service for **your own** commercial purposes, including advertising a
  business, reselling access, or arranging paid services performed in-game (this
  restriction applies to users of the Service; it does not restrict the Developer's own
  operation of the Service, including the optional Supporter subscription in §11);
- In a manner that violates the Bethesda EULA, the ZeniMax Terms of Service,
  or applicable law.

The Developer may suspend or terminate your access to the Service at any
time, for any reason or no reason, with or without notice.

## 4. Open source license

The desktop client and backend source code are published at
<https://github.com/UNN-Devotek/FCM-Fallout-Chat-Mod> under the MIT License.
You may inspect, modify, and redistribute the source under that license.
The MIT License is reproduced in the `LICENSE` file at the root of the
repository. Your obligations under the MIT License are independent of
these Terms.

## 5. No warranty

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY WARRANTY OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT. THE
DEVELOPER DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED,
ERROR-FREE, SECURE, OR THAT ANY DEFECT WILL BE CORRECTED.

## 6. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL THE
DEVELOPER BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL,
EXEMPLARY, OR PUNITIVE DAMAGES, INCLUDING WITHOUT LIMITATION DAMAGES FOR
LOSS OF PROFITS, REVENUE, DATA, USE, GOODWILL, OR THE INTEGRITY OF YOUR
BETHESDA ACCOUNT, EVEN IF THE DEVELOPER HAS BEEN ADVISED OF THE
POSSIBILITY OF SUCH DAMAGES.

THE DEVELOPER'S AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO THESE
TERMS OR YOUR USE OF THE SERVICE WILL NOT EXCEED ONE HUNDRED UNITED STATES
DOLLARS (USD $100.00).

## 7. Indemnification

You agree to defend, indemnify, and hold harmless the Developer from and
against any claim, demand, action, liability, loss, cost, or expense
(including reasonable attorneys' fees) arising out of or relating to: (a)
your use of the Service; (b) your violation of these Terms; (c) your
violation of the Bethesda EULA, ZeniMax Terms of Service, or applicable
law; or (d) any consequence imposed on you or others by Bethesda or
ZeniMax resulting from your use of the Service.

## 8. Changes

The Developer may revise these Terms at any time by posting an updated
version in the desktop client and at
<https://github.com/UNN-Devotek/FCM-Fallout-Chat-Mod/blob/prod/docs/TERMS.md>. Your
continued use of the Service after a revision constitutes acceptance of
the revised Terms.

## 9. Governing law

These Terms are governed by the laws of the State of New York, United
States, without regard to its conflict-of-laws principles. Any dispute
arising under these Terms must be brought exclusively in the state or
federal courts located in New York County, New York, and you consent to
the personal jurisdiction of those courts.

## 10. Contact

Questions or requests, including data deletion: open an issue on the project repository or use the contact form at `https://falloutchatmod.com`.

## 11. Supporter subscriptions

The Service offers an optional paid **Supporter** subscription. It is a voluntary
contribution toward hosting and development costs.

### 11.1 What it does and does not include

A Supporter subscription unlocks **cosmetic personalisation only** — additional colours
for your chat name, visual effects on your name, a short tag, and a badge.

It does **not** include, and will never include:

- Any chat, channel, party, moderation, or overlay functionality;
- Any in-game HUD mod functionality;
- Early access to features, builds, or downloads;
- Any advantage within *Fallout 76* itself.

All functional features of the Service are free to every user. Files published on
Nexus Mods are fully functional and free, with no paid component of any kind.

### 11.2 Billing, cancellation and refunds

Subscriptions are sold and processed through **Discord** as part of that platform's
server subscription system. **Discord is the merchant of record.** The Developer does
not receive, store, or process your payment card details.

Accordingly:

- Billing, renewal, cancellation, and refunds are handled **by Discord** under
  Discord's own terms and refund policy, not by the Developer;
- Prices displayed by Discord govern, and any applicable sales tax or VAT is collected
  and remitted by Discord;
- To cancel, use Discord's subscription management interface. Cancellation stops future
  billing; cosmetic privileges remain active for the remainder of the paid period.

### 11.3 Discord membership requirement

Supporter privileges are delivered through a role in the Fallout Chat Mod Discord
server. **You must be a member of that server for the cosmetic privileges to be
active.**

If you leave the server, or lose the role for any reason, cosmetic privileges are
**suspended** and your name reverts to its default appearance. Your underlying
entitlement is **retained** — rejoining the server restores your previous cosmetic
settings without any further payment.

### 11.4 Changes and availability

The Developer may add, change, or retire individual cosmetic options. If a cosmetic you
have selected is retired, your name reverts to a default appearance and no charge is
made for the change. The Developer may discontinue the Supporter programme entirely, in
which case active subscriptions will be allowed to lapse rather than being cancelled
mid-period, and no functional feature will be affected.

The Service is provided under §5 (No warranty) and §6 (Limitation of liability)
regardless of whether you hold a Supporter subscription.

---

*Fallout 76 is © ZeniMax Media Inc. All trademarks are the property of
their respective owners. This project is an unofficial fan tool with
no affiliation to ZeniMax or Bethesda.*
