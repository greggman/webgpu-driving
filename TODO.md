[x] Don't pick a static camera below the car?

    Quite often the auto camera picks a static point below the car in a spot
    where the car will be invisible. For example the camera is in a valley
    and the car above so the camera effectively looks at nothing. Another
    example, the camera is below a bridge so again can not see the car.
    Another example, the camera is behind a fence and the fence blocks most
    of the view of the car.
  
    Any solution is find. One idea, spend no
    more than 1 once per frame, looking for a suitable position. Check if the
    position will see the car. If not, check some new random position next frame,
    don't switch the camera until you find a good position.

[x] The telephone poles are rotated 90 degrees the wrong direction?

    I think the post at the top of the telephone pole is supposed to be
    perpendicular to wires it is carrying. Currently they are parallel

[ ] The windshield wipers are way too small for the window they are wiping

    Further, it would be nice to actually wipe the windows and maybe even warp
    the view outside through the water on the windows.

    That also means the passenger view's windows would have snow/water on them
    that is never wiped, though maybe pushed by the wind.

    The wiper is on in night drive biome even though there is no rain

[x] pressing C should probably cycle the camera through the modes.

    I think now it randomly choses. That means the user can't get to the camera they want.
    (though they can choose a camera in the settings)

[x] Pressing a number to switch biomes should not change the camera mode

[ ] Forest biome is slow

    I get that it has lots of trees. But a AAA game would have no problem
    displaying a scene like this. What would they do to make it performant?

[x] The desert biome needs tire marks behind the cars as well as dust
    behind other cars.

[x] The snow flake motion in the snow storm seems unrelated to the car's motion.

    Given the speed of the car the snow should be passing the camera at a higher speed.

[ ] More Biomes

    * New England Autumn trees on hillsides, gold, red, yellow, etc...

      Maybe occasionally lots of leaves on the road that get blown away by cars

    * Rainy night in Arizona
    
      Amazing lightning lighting up clouds. Wet roads. Drips on windshields that
      warp view.

[x] the close transition for trees from most detailed to next most details is sudden (500ms)

    That abruptness makes it stick out. Can we make it happen over a longer distance so it
    takes more time? I know that will be slower but we need to find something that's not
    so distracting.

[ ] Can we let the user control the camera?

    I think maybe an orbit camera around the car? Dolly to the car with wheel?
    I'm not sure the engine handles all angles. It would be nice to move the
    center of focus with arrows (left/right, up and down). We can limit it 5 or 10 meters
    and keep the camera above the ground?

[x] We should default to rendering in CSS pixels

    AFAIK, few of any games render at full res on a Mac.
    Let the user pick native res if they want in settings.
 
[x] Let the user cycle cars with some key

    And in settings. They don't need names. Can just be Car 1, Car 2, Car 3, etc.

[ ] Add more car types (maybe wait until the car looks good)

    * Pickup Trucks
    * Semi Trucks
    * Passenger Busses
 
[ ] In a previous demo we needed a 2 frame cap using onSubmittedWorkDone.

    That way we don't flood the GPU with too many frames.
