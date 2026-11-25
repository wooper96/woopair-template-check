import json
from pathlib import Path
import shutil
import sys
from uuid import UUID


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def package_site(destination):
    source = Path(__file__).resolve().parents[2]
    config = read_json(source / "league.json")
    if config["templateVersion"] != 1:
        raise ValueError("Unsupported WooPair website template version")
    name = config["displayName"]
    if name is not None and (not isinstance(name, str) or not name.strip()):
        raise ValueError("Invalid league website name")

    data = Path("data/tournaments")
    index = read_json(source / data / "index.json")
    if index["schemaVersion"] != 1 or not isinstance(index["tournaments"], list):
        raise ValueError("Invalid tournament index")

    files = [Path(name) for name in ("index.html", "league.json", "assets/site.css", "assets/site.js")]
    files.append(data / "index.json")
    seen = set()
    for entry in index["tournaments"]:
        event_id = str(UUID(entry["id"]))
        if event_id != entry["id"] or event_id in seen:
            raise ValueError("Invalid or repeated tournament ID in the index")
        seen.add(event_id)
        revision = str(UUID(entry["revision"]))
        if revision != entry["revision"]:
            raise ValueError(f"Invalid tournament revision for {event_id}")
        path = data / f"{event_id}.json"
        event = read_json(source / path)
        if event["schemaVersion"] != 1 or event["id"] != event_id or event["revision"] != revision:
            raise ValueError(f"Index and tournament revisions disagree for {event_id}")
        files.append(path)

    for path in files:
        source_file = source / path
        if source_file.resolve() != source_file:
            raise ValueError(f"Website input must not be a symbolic link: {path}")
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        if path == Path("league.json"):
            # GitHub Pages in branch mode would serve the original config from the repository.
            rendered = {**config, "deploymentSource": "workflow"}
            target.write_text(json.dumps(rendered, ensure_ascii=False) + "\n", encoding="utf-8")
        else:
            shutil.copyfile(source_file, target)


if __name__ == "__main__":
    package_site(Path(sys.argv[1]))
