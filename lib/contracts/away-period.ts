export interface AwayPeriod {
  id: string;
  from: string;
  until: string;
  source: "manual" | "scheduled";
  status?: "scheduled" | "active" | "completed";
  createdAt: string;
  updatedAt: string;
}
