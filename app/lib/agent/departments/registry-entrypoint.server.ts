// V-Sub-1 — Phase Sub-Agents. Registry entrypoint. Importing this module
// triggers each department's registerDepartment() side effect, populating
// the central registry. The sub-agent dispatcher imports this entrypoint
// FIRST so by the time runSubAgent() is called, every department is
// registered.
//
// Order of imports matters only for `allDepartmentSpecs()` which returns
// insertion order. Today: pilot first, then real departments as they
// migrate (Insights → Products → Pricing & Promotions).
//
// To add a new department: add an import line below. That's it. The
// registry pattern means everything else (CEO prompt's department list,
// the dispatcher, post-approval execution lookup) discovers the new
// department automatically.

import "./_pilot/index";
import "./insights/index";
import "./products/index";
import "./pricing-promotions/index";
