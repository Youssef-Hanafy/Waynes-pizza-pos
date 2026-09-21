# Wayne's printers: setup (Phase 7)

Wayne's has two Epson network printers. The POS is set up for exactly these models.

| | Front counter ("box") | Kitchen ("round top") |
| --- | --- | --- |
| Model | Epson **TM-T20III L** (M352A), thermal | Epson **TM-U220B** (M188B), impact / ribbon |
| Network | Built-in Ethernet | **UB-E04** Ethernet card (MAC `50:57:9C:58:F4:CE`) |
| Paper | 80 mm thermal, 48 characters a line | 76 mm plain paper, 40 characters a line |
| Prints | Customer receipts · **every online order**: order slip + tip & signature slip · test pages | **Kitchen tickets** for every order (register, phone, online) |
| Also | Cash drawer plugged into its DK port. The POS opens it through the printer | Black ribbon (ERC-38 B). With a black/red ribbon (ERC-38 B/R), "NO …" lines and notes print in red |
| Talks | ESC/POS, TCP port 9100 | ESC/POS, TCP port 9100 |

Both are already filled in under **Admin → Hardware**, switched **off**, because their IP addresses aren't known yet.

## 1. Find each printer's IP address (don't change anything)

Thrive still prints to these printers, so **only read the addresses. Don't change them.**

* **TM-T20III (front):** with the printer on and idle, press the small button on the back next to the network port once. It prints a status sheet. The IP address is on it. If nothing prints: turn the printer off, hold **FEED**, turn it on, and let go when it starts printing (self-test).
* **TM-U220B (kitchen):** press the small push button on the **UB-E04 card** on the back (a short press). It prints the network status sheet with the IP address.
* Or look in the router's DHCP leases for Epson devices. The kitchen card's MAC address is `50:57:9C:58:F4:CE`.
* If a sheet shows `192.168.192.168`, the printer didn't get an address from the router (Epson's factory default). Tell Youssef before going further.

In the router, **reserve** both addresses (a DHCP reservation / static lease) so they never change. Thrive and the POS both rely on them.

## 2. Enter them

Admin → Hardware → Printers:

1. **Receipt & online orders:** IP address, port `9100`, *How to print* = ESC/POS, paper 80 mm, tick **Printer on**. Leave *Print every online order* ticked. *Tip & signature slip* = Every online order (what the printer does today) or Only card orders.
2. **Kitchen tickets:** IP address, port `9100`, ESC/POS, paper 76 mm, **Printer on**. Tick *Black/red ribbon* only if a red/black ribbon is fitted. *Categories that print in the kitchen*: leave all unticked to print the whole order, or tick only the food categories (then drinks-only orders don't print in the kitchen).
3. Save. Then press **Test receipt printer**, **Test kitchen printer** and **Open cash drawer** on the same page, **from the Wayne's POS Android app** (a browser can't reach printers).
   The test page ends with a line-width ruler. It should fill one line exactly. If it wraps or stops short, type the right number into *Chars / line*. For the TM-U220B that's 40, or 42 if its DIP switch is set to the 42-column mode.

## 3. Turn on the print station

On the counter tablet (the Android app), open **POS → More → Print station** and tick **This register is the print station**. Do this on **one** register only.

From then on:

* Every order that reaches the kitchen gets a kitchen ticket on the TM-U220B.
* Every online order prints its order slip, then the tip & signature slip, on the TM-T20III.
* It happens within a second or two (Supabase Realtime), with a 20-second safety check.
* **Printer off or unplugged?** Nothing is lost. Tickets wait, the POS header shows *"Kitchen printer: … Tickets are waiting"*, and they print as soon as it answers.
* **Paper jam mid-print?** That ticket is **not** reprinted automatically. It shows in **Admin → Printing** as *needs inspection*, so the kitchen never gets a surprise duplicate. Check the paper, then press *Retry*.
* Anything over an hour old isn't printed automatically. It waits in Admin → Printing.
* If a second register is switched on by mistake, nothing prints twice: the database hands each ticket to one station only.

Receipts for counter and phone orders print from the **Print receipt** button on the order-sent screen. The cash drawer opens with **Open drawer** (Admin → Hardware test, and the POS drawer panel).

## Running alongside Thrive

Both systems can send to the same printers (port 9100 takes one job at a time; the other waits a moment). While Thrive is still live, an online order that comes through **both** systems prints twice. Keep *Print every online order* **unticked** until online orders move to this website, then tick it.
