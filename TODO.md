[x] Turn off hud by default

[x] The forest flower road has way too much fog

    I'm not sure it needs any fog. it also has no flowers
    as far as I can tell. What I imagined is the grass renderer
    rendering ~1 meter high billboard plants with flowers on top.

[ ] Build assets as needed

    Currently, all shaders, pipelines, cars, and all biome assets are built at startup.
    Instead, we should build just the first car, and just the props etc
    needed for the first biome. When the user switches cars or biomes
    we can build stuff for that.