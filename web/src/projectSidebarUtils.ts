import type { Project, Session } from "./types";

export interface ProjectSidebarGroups {
  grouped: Map<string, Session[]>;
  orderedProjects: Project[];
  unassigned: Session[];
}

export function groupProjectSidebarSessions(
  projects: Project[],
  sessions: Session[],
): ProjectSidebarGroups {
  const knownProjectIDs = new Set(projects.map((project) => project.id));
  const grouped = new Map<string, Session[]>();
  const unassigned: Session[] = [];

  for (const session of sessions) {
    if (!session.projectId || !knownProjectIDs.has(session.projectId)) {
      unassigned.push(session);
      continue;
    }
    const group = grouped.get(session.projectId);
    if (group) group.push(session);
    else grouped.set(session.projectId, [session]);
  }

  return { grouped, orderedProjects: projects, unassigned };
}

export function flattenProjectSidebarSessions(
  projects: Project[],
  sessions: Session[],
): Session[] {
  const { grouped, orderedProjects, unassigned } = groupProjectSidebarSessions(
    projects,
    sessions,
  );
  return [
    ...orderedProjects.flatMap((project) => grouped.get(project.id) ?? []),
    ...unassigned,
  ];
}
