[ ] Turn off hud by default

[ ] The forest flower road has way too much fog

    I'm not sure it needs any fog. it also has no flowers
    as far as I can tell. What I imagined is the grass renderer
    rendering ~1 meter high billboard plants with flowers on top.

[ ] Build assets as needed

    Currently, all shaders, pipelines, cars, and all biome assets are built at startup.
    Instead, we should build just the first car, and just the props etc
    needed for the first biome. When the user switches cars or biomes
    we can build stuff for that.

[ ] Correct the snow particles motion

    The snow particles often look like they are swishing around
    even when the camera is facing forward and the car is going 50mph.
    In that situation, the snow should pretty much always appear to go into
    the window/camera.

[ ] Remove the leave/petal particles in the forest with flowers biome

    The area is full of particles for no reason

[ ] Remove the fog in the forest with flowers biome

    or set it 10x lower. As it is it makes the forest look washed out

[ ] The on-demand asset generation needs work

    Is it is, the app starts, the car appears to be driving down the road,
    then the system freezes for 500ms to 2000ms, the goes for a moment, then freezes again.

    Best solution, if it works, build the assets in a worker, pass them back to the
    main thread via transferred typed arrays. In the main thread, render without those
    assets and start rendering with them when the asset is finally available, but
    don't hold up the rendering in general.

    If that still has too much jank, then we should make sure everything that's needed
    for the current biome is generated before starting.

