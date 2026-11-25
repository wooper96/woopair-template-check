const heading = document.querySelector("#league-name");
const status = document.querySelector("#status");
const tournaments = document.querySelector("#tournaments");

async function readJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error("Website data is unavailable");
  return response.json();
}

async function loadLeague() {
  const [league, index] = await Promise.all([readJson("./league.json"), readJson("./data/tournaments/index.json")]);
  if (league.displayName) heading.textContent = document.title = league.displayName;
  if (!index.tournaments.length) {
    status.textContent = "No tournaments have been published yet.";
    return;
  }

  for (const event of index.tournaments) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `./data/tournaments/${encodeURIComponent(event.id)}.json`;
    link.textContent = `${event.displayName} (JSON)`;
    item.append(link);
    tournaments.append(item);
  }
  tournaments.hidden = false;
  status.hidden = true;
}

loadLeague().catch(() => { status.textContent = "Tournament data is unavailable. Refresh the page to try again."; });
