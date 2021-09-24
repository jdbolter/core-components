/**
 * Description
 * ===========
 * Bidirectional see-through portal. Two portals are paired by color.
 *
 * Usage
 * =======
 * Add two instances of `portal.glb` to the Spoke scene.
 * The name of each instance should look like "some-descriptive-label__color"
 * Any valid THREE.Color argument is a valid color value.
 * See here for example color names https://www.w3schools.com/cssref/css_colors.asp
 *
 * For example, to make a pair of connected blue portals,
 * you could name them "portal-to__blue" and "portal-from__blue"
 */

import './proximity-events.js'
import vertexShader from '../shaders/portal.vert.js'
import fragmentShader from '../shaders/portal.frag.js'
import snoise from '../shaders/snoise.js'
import { showRegionForObject, hiderRegionForObject } from './region-hider.js'
import { findAncestorWithComponent } from '../utils/scene-graph'

const worldPos = new THREE.Vector3()
const worldCameraPos = new THREE.Vector3()
const worldDir = new THREE.Vector3()
const worldQuat = new THREE.Quaternion()
const mat4 = new THREE.Matrix4()

function mapMaterials(object3D, fn) {
    let mesh = object3D 
    if (!mesh.material) return;
  
    if (Array.isArray(mesh.material)) {
      return mesh.material.map(fn);
    } else {
      return fn(mesh.material);
    }
}
  
AFRAME.registerSystem('portal', {
  dependencies: ['fader-plus'],
  init: function () {
    this.teleporting = false
    this.characterController = this.el.systems['hubs-systems'].characterController
    this.fader = this.el.systems['fader-plus']
    this.roomData = null
    this.waitForFetch = this.waitForFetch.bind(this)

    // if the user is logged in, we want to retrieve their userData from the top level server
    if (window.APP.store.state.credentials && window.APP.store.state.credentials.token && !window.APP.userData) {
        this.fetchRoomData()
    }
  },
  fetchRoomData: async function () {
    var params = {token: window.APP.store.state.credentials.token,
                  room_id: window.APP.hubChannel.hubId}

    const options = {};
    options.headers = new Headers();
    options.headers.set("Authorization", `Bearer ${params}`);
    options.headers.set("Content-Type", "application/json");
    await fetch("https://realitymedia.digital/userData", options)
        .then(response => response.json())
        .then(data => {
          console.log('Success:', data);
          this.roomData = data;
    })
    this.roomData.textures = []
  },
  getRoomURL: async function (number) {
      this.waitForFetch()
      //return this.roomData.rooms.length > number ? "https://xr.realitymedia.digital/" + this.roomData.rooms[number] : null;
      let url = window.SSO.userInfo.rooms.length > number ? "https://xr.realitymedia.digital/" + window.SSO.userInfo.rooms[number] : null;
      return url
  },
  getCubeMap: async function (number) {
      this.waitForFetch()
      return this.roomData.cubemaps.length > number ? this.roomData.cubemaps[number] : null;
  },
  waitForFetch: function () {
     if (this.roomData && window.SSO.userInfo) return
     setTimeout(this.waitForFetch, 100); // try again in 100 milliseconds
  },
  teleportTo: async function (object) {
    this.teleporting = true
    await this.fader.fadeOut()
    // Scale screws up the waypoint logic, so just send position and orientation
    object.getWorldQuaternion(worldQuat)
    object.getWorldDirection(worldDir)
    object.getWorldPosition(worldPos)
    worldPos.add(worldDir.multiplyScalar(1.5)) // Teleport in front of the portal to avoid infinite loop
    mat4.makeRotationFromQuaternion(worldQuat)
    mat4.setPosition(worldPos)
    // Using the characterController ensures we don't stray from the navmesh
    this.characterController.travelByWaypoint(mat4, true, false)
    await this.fader.fadeIn()
    this.teleporting = false
  },
})

AFRAME.registerComponent('portal', {
  schema: {
    portalType: { default: "" },
    portalTarget: { default: "" },
    color: { type: 'color', default: null },
    materialTarget: { type: 'string', default: null }
  },
  init: async function () {
    this.system = window.APP.scene.systems.portal // A-Frame is supposed to do this by default but doesn't?

    if (this.data.portalType.length > 0 ) {
        this.setPortalInfo(this.data.portalType, this.data.portalTarget, this.data.color)
    } else {
        this.portalType = 0
    }

    if (this.portalType == 0) {
        // parse the name to get portal type, target, and color
        this.parseNodeName()
    }
    
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      uniforms: {
        cubeMap: { value: new THREE.Texture() },
        time: { value: 0 },
        radius: { value: 0 },
        ringColor: { value: this.color },
      },
      vertexShader,
      fragmentShader: `
        ${snoise}
        ${fragmentShader}
      `,
    })

    // Assume that the object has a plane geometry
    //const mesh = this.el.getOrCreateObject3D('mesh')
    //mesh.material = this.material
    this.replaceMaterial(this.material)

    // get the other before continuing
    this.other = await this.getOther()

    if (this.portalType == 1) {
        this.system.getCubeMap(this.portalTarget).then( urls => {
            //const urls = [cubeMapPosX, cubeMapNegX, cubeMapPosY, cubeMapNegY, cubeMapPosZ, cubeMapNegZ];
            const texture = new Promise((resolve, reject) =>
              new THREE.CubeTextureLoader().load(urls, resolve, undefined, reject)
            ).then(texture => {
                texture.format = THREE.RGBFormat;
                this.material.uniforms.cubeMap.value = texture;
            }).catch(e => console.error(e))    
        })
    } else if (this.portalType == 2 || this.portalType == 3) {    
        this.cubeCamera = new THREE.CubeCamera(1, 100000, 1024)
        this.cubeCamera.rotateY(Math.PI) // Face forwards
        if (this.portalType == 2) {
            this.el.object3D.add(this.cubeCamera)
            this.other.components.portal.material.uniforms.cubeMap.value = this.cubeCamera.renderTarget.texture    
        } else {
            let waypoint = document.getElementsByClassName(this.portalTarget)
            if (waypoint.length > 0) {
                waypoint = waypoint.item(0)
                waypoint.object3D.add(this.cubeCamera)
                this.material.uniforms.cubeMap.value = this.cubeCamera.renderTarget.texture;
            }
        }
        this.el.sceneEl.addEventListener('model-loaded', () => {
            showRegionForObject(this.el)
            this.cubeCamera.update(this.el.sceneEl.renderer, this.el.sceneEl.object3D)
            hiderRegionForObject(this.el)
        })
    }

    this.el.setAttribute('animation__portal', {
        property: 'components.portal.material.uniforms.radius.value',
        dur: 700,
        easing: 'easeInOutCubic',
    })
    // this.el.addEventListener('animationbegin', () => (this.el.object3D.visible = true))
    // this.el.addEventListener('animationcomplete__portal', () => (this.el.object3D.visible = !this.isClosed()))

    // going to want to try and make the object this portal is on clickable
    this.el.setAttribute('is-remote-hover-target','')
    this.el.setAttribute('tags', {singleActionButton: true})
    //this.el.setAttribute('class', "interactable")
    // orward the 'interact' events to our portal movement 
    //this.followPortal = this.followPortal.bind(this)
    //this.el.object3D.addEventListener('interact', this.followPortal)

    this.el.setAttribute('proximity-events', { radius: 5 })
    this.el.addEventListener('proximityenter', () => this.open())
    this.el.addEventListener('proximityleave', () => this.close())
  },

  replaceMaterial: function (newMaterial) {
    let target = this.data.materialTarget
    if (target && target.length == 0) {target=null}
    
    let traverse = (object) => {
      let mesh = object
      if (mesh.material) {
          mapMaterials(mesh, (material) => {         
              if (!target || material.name === target) {
                  mesh.material = newMaterial
              }
          })
      }
      const children = object.children;
      for (let i = 0; i < children.length; i++) {
          traverse(children[i]);
      }
    }

    let replaceMaterials = () => {
    // mesh would contain the object that is, or contains, the meshes
    var mesh = this.el.object3DMap.mesh
    if (!mesh) {
        // if no mesh, we'll search through all of the children.  This would
        // happen if we dropped the component on a glb in spoke
        mesh = this.el.object3D
    }
    traverse(mesh);
    this.el.removeEventListener("model-loaded", initializer);
    }

    let root = findAncestorWithComponent(this.el, "gltf-model-plus")
    let initializer = () =>{
      if (this.el.components["media-loader"]) {
          this.el.addEventListener("media-loaded", replaceMaterials)
      } else {
          replaceMaterials()
      }
    };
    root.addEventListener("model-loaded", initializer);
  },

//   followPortal: function() {
//     if (this.portalType == 1) {
//         console.log("set window.location.href to " + this.other)
//         window.location.href = this.other
//       } else if (this.portalType == 2) {
//         this.system.teleportTo(this.other.object3D)
//       }
//   },
  tick: function (time) {
    this.material.uniforms.time.value = time / 1000
        
    if (this.other && !this.system.teleporting) {
      this.el.object3D.getWorldPosition(worldPos)
      this.el.sceneEl.camera.getWorldPosition(worldCameraPos)
      const dist = worldCameraPos.distanceTo(worldPos)

      if (this.portalType == 1 && dist < 1) {
          if (!this.locationhref) {
            console.log("set window.location.href to " + this.other)
            this.locationhref = this.other
            window.location.href = this.other
          }
      } else if (this.portalType == 2 && dist < 1) {
        this.system.teleportTo(this.other.object3D)
      } else if (this.portalType == 3) {
          if (dist < 1) {
            if (!this.locationhref) {
              console.log("set window.location.hash to " + this.other)
              this.locationhref = this.other
              window.location.hash = this.other
            }
          } else {
              // if we set locationhref, we teleported.  when it
              // finally happens, and we move outside the range of the portal,
              // we will clear the flag
              this.locationhref = null
          }
      }
    }
  },
  getOther: function () {
    return new Promise((resolve) => {
        if (this.portalType == 0) resolve(null)
        if (this.portalType  == 1) {
            // the target is another room, resolve with the URL to the room
            this.system.getRoomURL(this.portalTarget).then(url => { resolve(url) })
        }
        if (this.portalType == 3) {
            resolve ("#" + this.portalTarget)
        }

        // now find the portal within the room.  The portals should come in pairs with the same portalTarget
        const portals = Array.from(document.querySelectorAll(`[portal]`))
        const other = portals.find((el) => el.components.portal.portalType == this.portalType &&
                                            el.components.portal.portalTarget === this.portalTarget && el !== this.el)
        if (other !== undefined) {
            // Case 1: The other portal already exists
            resolve(other);
            other.emit('pair', { other: this.el }) // Let the other know that we're ready
        } else {
            // Case 2: We couldn't find the other portal, wait for it to signal that it's ready
            this.el.addEventListener('pair', (event) => resolve(event.detail.other), { once: true })
        }
    })
  },

    parseNodeName: function () {
        const nodeName = this.el.parentEl.parentEl.className

        // nodes should be named anything at the beginning with either 
        // - "room_name_color"
        // - "portal_N_color" 
        // at the very end. Numbered portals should come in pairs.
        const params = nodeName.match(/([A-Za-z]*)_([A-Za-z0-9]*)_([A-Za-z0-9]*)$/)
        
        // if pattern matches, we will have length of 4, first match is the portal type,
        // second is the name or number, and last is the color
        if (!params || params.length < 4) {
            console.warn("portal node name not formed correctly: ", nodeName)
            this.portalType = 0
            this.portalTarget = null
            this.color = "red" // default so the portal has a color to use
            return;
        } 
        this.setPortalInfo(params[1], params[2], params[3])
    },

    setPortalInfo: function(portalType, portalTarget, color) {
        if (portalType === "room") {
            this.portalType = 1;
            this.portalTarget = parseInt(portalTarget)
        } else if (portalType === "portal") {
            this.portalType = 2;
            this.portalTarget = portalTarget
        } else if (portalType === "waypoint") {
            this.portalType = 3;
            this.portalTarget = portalTarget
        } else {
            this.portalType = 0;
            this.portalTarget = null
        } 
        this.color = new THREE.Color(color)
    },

    setRadius(val) {
        this.el.setAttribute('animation__portal', {
          from: this.material.uniforms.radius.value,
          to: val,
        })
    },
    open() {
        this.setRadius(1)
    },
    close() {
        this.setRadius(0)
    },
    isClosed() {
        return this.material.uniforms.radius.value === 0
    },
})