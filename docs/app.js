const dataUrl = "robots.json";
const issueUrl =
  "https://github.com/urdf-studio/urdf-robot-gallery/issues/new?template=robot_repo_submission.yml";

const grid = document.getElementById("grid");
const emptyState = document.getElementById("empty");
const countEl = document.getElementById("robot-count");
const searchInput = document.getElementById("search-input");

const state = {
  robots: [],
  query: "",
};

const normalize = (value) => (value || "").toString().toLowerCase();

const matchesQuery = (robot, query) => {
  if (!query) return true;
  const haystack = [
    robot.name,
    robot.org,
    robot.summary,
    robot.repo,
    robot.demo,
    ...(robot.tags || []),
  ]
    .map(normalize)
    .join(" ");
  return haystack.includes(query);
};

const renderCard = (robot) => {
  const card = document.createElement("div");
  card.className = "card";

  const heading = document.createElement("div");
  const name = document.createElement("h3");
  name.textContent = robot.name;
  heading.appendChild(name);
  if (robot.org) {
    const org = document.createElement("div");
    org.className = "org";
    org.textContent = robot.org;
    heading.appendChild(org);
  }

  const summary = document.createElement("p");
  summary.textContent = robot.summary;

  const tags = document.createElement("div");
  tags.className = "tags";
  (robot.tags || []).forEach((tag) => {
    const badge = document.createElement("span");
    badge.className = "tag";
    badge.textContent = tag;
    tags.appendChild(badge);
  });

  const links = document.createElement("div");
  links.className = "links";

  const repoLink = document.createElement("a");
  repoLink.href = robot.repo;
  repoLink.target = "_blank";
  repoLink.rel = "noopener noreferrer";
  repoLink.textContent = "GitHub →";
  links.appendChild(repoLink);

  if (robot.demo) {
    const demoLink = document.createElement("a");
    demoLink.href = robot.demo;
    demoLink.target = "_blank";
    demoLink.rel = "noopener noreferrer";
    demoLink.className = "secondary";
    demoLink.textContent = "Demo →";
    links.appendChild(demoLink);
  }

  card.appendChild(heading);
  card.appendChild(summary);
  if (robot.tags && robot.tags.length) {
    card.appendChild(tags);
  }
  card.appendChild(links);

  return card;
};

const render = () => {
  const query = normalize(state.query);
  const filtered = state.robots.filter((robot) => matchesQuery(robot, query));

  grid.innerHTML = "";
  filtered.forEach((robot) => grid.appendChild(renderCard(robot)));

  countEl.textContent = state.robots.length.toString();
  emptyState.classList.toggle("hidden", filtered.length > 0);

  if (state.robots.length === 0) {
    emptyState.querySelector("a").href = issueUrl;
  }
};

searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

fetch(dataUrl)
  .then((response) => response.json())
  .then((robots) => {
    if (!Array.isArray(robots)) {
      throw new Error("robots.json must be an array");
    }
    state.robots = robots;
    render();
  })
  .catch(() => {
    state.robots = [];
    render();
  });
