// V-Sub-1 — Phase Sub-Agents. Registry entrypoint. Importing this module
// triggers each department's registerDepartment() side effect, populating
// the central registry. The sub-agent dispatcher imports this entrypoint
// FIRST so by the time runSubAgent() is called, every department is
// registered.
//
// Order of imports matters only for `allDepartmentSpecs()` which returns
// insertion order — kept matching the legacy DEPARTMENTS array order in
// departments.ts so the prompt and the routing pill render in the same
// order across server/client.
//
// V-Sub-5 — _pilot department removed; it served its purpose validating
// the dispatcher infrastructure and is no longer needed.
//
// To add a new department: add an import line below. That's it. The
// registry pattern means everything else (CEO prompt's department list,
// the dispatcher, post-approval execution lookup) discovers the new
// department automatically.

import "./products/index";
import "./pricing-promotions/index";
import "./insights/index";
import "./marketing/index";
import "./customers/index";
import "./orders/index";
