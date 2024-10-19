// This scripts relies on two things:
// 1. `workspace.desktops` and `client.desktops` giving me desktops in the same
//   order as in pager and all context menus
// 2. Desktops being comparable for equality with `==` operator

// Desktop numbers are from zero (unlike how it worked in plasma 5)


const MIN_DESKTOPS = 2;
const LOG_LEVEL = 2; // 0 trace, 1 debug, 2 info


function log(...args) { print("[dynamic_workspaces] ", ...args); }
function debug(...args) { if (LOG_LEVEL <= 1)  log(...args); }
function trace(...args) { if (LOG_LEVEL <= 0)  log(...args); }


/*****  Plasma 5/6 differences  *****/


const isKde6 = typeof workspace.windowList === "function";
const compat = isKde6
	?
		{ addDesktop = () =>
			{ workspace.createDesktop(workspace.desktops.length, "Dynamic"); }
		, windowAddedSignal = ws => ws.windowAdded
		, windowList = ws => ws.windowList()
		, desktopChangedSignal = c => c.desktopsChanged

		, toDesktop = d => d
		, workspaceDesktops = () => workspace.desktops
		, lastDesktop = () => workspace.desktops[workspace.desktops.length - 1]
		, deleteLastDesktop = () =>
			{
				const last = workspace.desktops[workspace.desktops.length - 1];
				workspace.removeDesktop(last);
			}
		, findDesktop = (ds, d) => ds.indexOf(d)

		, clientDesktops = c => c.desktops
		, setClientDesktops = (c, ds) =>
			{
				c.desktops = ds;
			}
		, clientOnDesktop = (c, d) => c.desktops.indexOf(d) !== -1
		}
	:
		{ addDesktop = () =>
			{ workspace.createDesktop(workspace.desktops, "Dynamic"); }
		, windowAddedSignal = ws => ws.clientAdded
		, windowList = ws => ws.clientList()
		, desktopChangedSignal = c => c.desktopChanged

		// emulate plasma 6 behaviour with custom types
		, toDesktop = number => {{ index: number - 1 }}
		, workspaceDesktops = () =>
			{
				let r = [];
				for (let i = 0; i < workspace.desktops; ++i)
				{
					const desktop =
						{ index: i
						};
					r.push(desktop);
				}
				return r;
			}
		, lastDesktop = () => {{ index: workspace.desktops - 1 }}
		, deleteLastDesktop = () =>
			{ workspace.removeDesktop(workspace.desktops - 1); }
		, findDesktop = (ds, d) =>
			{
				for (let i = 0; i < ds.length; ++i)
				{
					if (ds[i].index === d.index)
					{
						return i;
					}
				}
				return -1;
			}

		, clientDesktops = c =>
			c
				.x11DesktopIds
				.map(id => {return {index: id - 1}})
		, setClientDesktops = (c, ds) =>
			{
				// Plasma 5 is supports window on multiple desktops, and there
				// are even functions for it in the API, but they are bugged.
				// So we have to do this. So far, noone has complained, so
				// maybe noone uses this feature?
				c.desktop = ds[0];
			}
		, clientOnDesktop = (c, d) => c.desktop === d.index + 1
		};


/*****  Logic definition  *****/


// shifts a window to the left if it's more to the right than number
function shiftRighterThan(client, number)
{
	trace(`shiftRighterThan(${client.caption}, ${number})`);
	if (number === 0)  return;
	// Build a new array by comparing old client desktops with all available
	// desktops
	const allDesktops = compat.workspaceDesktops();
	const clientDesktops = compat.clientDesktops(client);
	let newDesktops = [];
	// first add unchanged desktops
	for (let i = 0; i < number; ++i)
	{
		const d = allDesktops[i];
		if (compat.findDesktop(clientDesktops, d) !== -1)
		{
			newDesktops.push(d);
		}
	}
	// then for every desktop after `number`, add a desktop before that
	for (let i = number; i < allDesktops.length; ++i)
	{
		const d = allDesktops[i];
		if (compat.findDesktop(clientDesktops, d) !== -1)
		{
			newDesktops.push(allDesktops[i-1]);
		}
	}

	compat.setClientDesktops(client, newDesktops);
}

/**
 * Delete a desktop by index
 *
 * @returns true if desktop was deleted, false if wasn't
 */
function removeDesktop(number)
{
	trace(`removeDesktop(${number})`);

	const desktopsLength = compat.workspaceDesktops().length;
	if (desktopsLength - 1 <= number)
	{
		debug("Not removing desktop at end");
		return false;
	}
	if (desktopsLength <= MIN_DESKTOPS)
	{
		debug("Not removing desktop, too few left");
		return false;
	}
	
	// plasma6 allows us to delete desktops in the middle. Unfortunately, this
	// messes up pager, so we have to do what we did un plasma5 and shift all
	// windows by hand to delete the last desktop
	compat.windowList(workspace).forEach((client) =>
	{
		shiftRighterThan(client, number)
	});
	compat.deleteLastDesktop();
	debug("Desktop removed");
	return true;
}

// tells if desktop has no windows of its own
function isEmptyDesktop(number)
{
	trace(`isEmptyDesktop(${number})`)
	const desktop = compat.workspaceDesktops()[number];
	const cls = compat.windowList(workspace);
	for (client of cls)
	{
		if (compat.clientOnDesktop(client, desktop)
			&& !client.skipPager // ignore hidden windows
			&& !client.onAllDesktops // ignore windows on all desktops
		) {
			debug(`Desktop ${number} not empty because ${client.caption} is there`);
			return false;
		}
	}

	return true;
}

/**
 * Checks for new created or moved windows if they are occupying the last desktop
 * -> if yes, create new one to the right
 */
function onDesktopChangedFor(client)
{
	trace(`onDesktopChangedFor(${client.caption})`);

	const lastDesktops = compat.lastDesktop();
	if (compat.clientOnDesktop(client, lastDesktops))
	{
		compat.addDesktop();
	}
}

/**
 * When creating new windows, check whether they are occupying the last desktop
 */
function onClientAdded(client)
{
	if (client === null)
	{
		log("onClientAdded(null) - that may happen rarely");
		return;
	}
	trace(`onClientAdded(${client.caption})`);

	if (client.skipPager)
	{
		debug("Ignoring added hidden window");
		return;
	}

	// add a new desktop for a client too right
	if (compat.clientOnDesktop(client, compat.lastDesktop()))
	{
		compat.addDesktop();
	}

	// subscribe the client to create desktops when desktop switched
	compat.desktopChangedSignal(client).connect(() => { onDesktopChangedFor(client); });
}

/**
 * Deletes empty desktop to the right or left incase of desktop switch
 */
function onDesktopSwitch(oldDesktop) {
    trace(`onDesktopSwitch(${oldDesktop})`);

    const allDesktops = compat.workspaceDesktops();
    const oldDesktopIndex = compat.findDesktop(allDesktops, compat.toDesktop(oldDesktop));
    const currentDesktopIndex = compat.findDesktop(allDesktops, compat.toDesktop(workspace.currentDesktop));

    // Check if the user moved away from the first desktop
    if (oldDesktopIndex === 0 && currentDesktopIndex !== 0) {
        // If the first desktop is empty, delete it and shift others left
        if (isEmptyDesktop(0)) {
            debug("Deleting the first desktop and shifting others left...");

            // Shift all windows left from the second desktop onwards
            compat.windowList(workspace).forEach(client => {
                shiftRighterThan(client, 1); // Shift all windows from desktop 1
            });

            // Delete the first desktop
            compat.deleteLastDesktop();
            
           
            debug("First desktop deleted and others shifted.");
        }
    }

    // Remove empty desktops to the left of the current desktop
    for (let desktopIdx = currentDesktopIndex - 1; desktopIdx >= 0; desktopIdx--) {
        debug(`Examining desktop ${desktopIdx} (left)`);
        if (isEmptyDesktop(desktopIdx)) {
            removeDesktop(desktopIdx);
        }
    }

    // Remove empty desktops to the right of the current desktop
    for (let desktopIdx = currentDesktopIndex + 1; desktopIdx < allDesktops.length; desktopIdx++) {
        debug(`Examining desktop ${desktopIdx} (right)`);
        if (isEmptyDesktop(desktopIdx)) {
            removeDesktop(desktopIdx);
        }
    }

    // Check if we need to add a new desktop if the last one is occupied
    if (compat.clientOnDesktop(compat.windowList(workspace)[0], compat.lastDesktop())) {
        compat.addDesktop();
    }


}



/*****  Main part *****/


// Adding or removing a client might create desktops.
// For all existing clients:
compat.windowList(workspace).forEach(onClientAdded);
// And for all future clients:
compat.windowAddedSignal(workspace).connect(onClientAdded);

// Switching desktops might remove desktops
workspace.currentDesktopChanged.connect(onDesktopSwitch);
