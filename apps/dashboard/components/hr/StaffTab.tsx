"use client";

import { useState } from "react";
import "./hr.css";
import { StaffProfiles } from "./StaffProfiles";
import { AttendanceView } from "./AttendanceView";
import { RosterView } from "./RosterView";
import { LeaveView } from "./LeaveView";
import { PayrollView } from "./PayrollView";
import { StaffSalesView } from "./StaffSalesView";

type View = "profiles" | "attendance" | "roster" | "leave" | "payroll" | "performance";
const VIEWS: { id: View; label: string }[] = [
  { id: "profiles", label: "Profiles" },
  { id: "attendance", label: "Attendance" },
  { id: "roster", label: "Roster" },
  { id: "leave", label: "Leave" },
  { id: "payroll", label: "Payroll" },
  { id: "performance", label: "Sales performance" },
];

export function StaffTab({ outletId }: { outletId: string }) {
  const [view, setView] = useState<View>("profiles");
  return (
    <div className="tab-pane">
      <div className="pane-head">
        <h1>Staff</h1>
        <div className="seg">
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? "on" : ""} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      </div>
      {view === "profiles" && <StaffProfiles outletId={outletId} />}
      {view === "attendance" && <AttendanceView outletId={outletId} />}
      {view === "roster" && <RosterView outletId={outletId} />}
      {view === "leave" && <LeaveView outletId={outletId} />}
      {view === "payroll" && <PayrollView outletId={outletId} />}
      {view === "performance" && <StaffSalesView outletId={outletId} />}
    </div>
  );
}
