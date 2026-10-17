### Added
- A pi session asleep in its pane stays in the Agents list, its mark dimmed with an Asleep badge on
  a connected PC (a PC that is away keeps its title and no badge), and its chat reads its
  transcript. There is one row per sleeping session, however herdr names its pane. Selecting it
  opens its chat wherever an agent's pane does (Panes open in: Chat, or Auto on a touch screen). Its
  card offers Resume, and Quit after a confirmation, while the launcher's banner is the pane's last
  line.
- A pi session asleep in its pane is named by its own title in the header, the tab strip, the
  workspace rows when Sidebar rows is Two lines, the document title, alerts and the command palette,
  not by the launcher's `zz` title. Its workspace row keeps the pi mark and shows a moon labelled
  Asleep, on a connected PC.
- A message sent from the chat composer to a sleeping pi session wakes it with Enter first and is
  typed once pi reports ready. If pi would restore an unsent draft, or is not ready in time, nothing
  is typed and the text stays in the composer with the reason. A message sent while pi is waking,
  including right after Resume, is refused the same way. If a wake runs out with pi not ready, the
  next chat message to a pane whose sleep has ended is refused once, with nothing typed, unless
  herdr names pi for the pane; a session still asleep is woken again instead.

### Fixed
- A message sent from the chat composer to a pi session asleep in its pane no longer goes into the
  sleep launcher, which dropped it.
- A chat message that is exactly `q` no longer quits a sleeping pi session: it wakes the session,
  then is typed like any other message.
- A pane herdr lists as `zz pi`, the sleep launcher's label, no longer shows as an unknown agent;
  without a sleeping session behind it, the pane is a plain terminal.
- A message sent while a sleeping pi session is waking is no longer typed into a pi that is still
  starting; it is refused with nothing typed while pi is still waking.
- A message sent while a pi session is going to sleep is no longer typed into a pi that is exiting;
  it is refused with nothing typed until the pane shows as asleep, for at most 15 seconds from the
  sleep's start.
