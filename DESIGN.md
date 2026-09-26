# WebGPU Driving

Make a casual driving simulation in WebGPU with no libraries. Use typescript, esbuild, gts
and have a github action to publish on github pages. Use WebGPU best practices.

The world, cars, and car interior, should all be procedurally generated.
The idea is simulate a relaxing drive through various environments.
Only one environment at a time.

* A winding country road 

  with rolling hills, farms, hedges, crops, grass, trees

* A winding dirt desert road 

  rocks, cactus, tumbleweeds, long vistas, mountains

* A ocean coastline road

  hills and cliffs on one side, and ocean on the other. Canyons, bridges

* A flower lined road through a forest

* Driving though a snow storm in the Pennsylvania country side

* Driving down a fence lined road like La Honda Rd in California

* Night driving with headlights, stars and moon.

It should look amazing! Like a car commercial that shows driving
It should use techniques from AAA games.
It must use various terrain LODing techniques. Frustum based grass and bush systems.
Rayleigh based sky and sun effects. It should have beautiful vistas.

The project can be tested with puppeteer, no special arguments are needed. If serving
the page use express for local testing.

Have at least one agent who's sole duty is to judge if the result matches AAA
games.

Take inspiration from games like "Slow Roads", "DiRT", "Forza Horizon 5" 

Note that the roads, though winding, generally go in one direction. Take advantage of
this fact to deal with draw distance and Potentially Visible Set (PVS) type issues.
The car can not leave the road, it can not crash. You can switch lanes, speed up,
slow down. You can not crash into other cars. You can not change roads, there is only
one road. All of these features add constraints that should inform the rendering system
and physics and collisions. The car should drive itself by default with the camera
switching from helicopter type view, to external camera rig view, to interior view,
etc....