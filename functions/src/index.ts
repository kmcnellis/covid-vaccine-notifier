import * as functions from "firebase-functions";
import axios, {AxiosResponse, AxiosError} from "axios";
import * as admin from "firebase-admin";
import * as status from "http-status";
import {isValidCoordinate, getDistance, convertDistance} from "geolib";
import phone = require("phone");
import {Client} from "@googlemaps/google-maps-services-js";
import twilio = require("twilio");

// Your Account SID from www.twilio.com/console
const accountSid = functions.config().twilio.sid;
// Your API Key from www.twilio.com/console
const apiKey = functions.config().twilio.key;
// Your API Secret from www.twilio.com/console
const apiSecret = functions.config().twilio.secret;
// Purchased phone number
const twilioNumber = functions.config().twilio.phone;
const twilioClient = twilio(apiKey, apiSecret, {
  accountSid: accountSid,
  lazyLoading: true,
});

const mapsAPI = functions.config().maps.key; // Google Maps-scoped api key

admin.initializeApp();
const db = admin.database();

const apiURL = "https://www.vaccinespotter.org/api/v0/states";
// const states = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "PR", "RI", "SC", "SD", "TN", "TX", "VI", "UT", "VT", "VA", "WA", "WV", "WI", "WY",]
const states = ["CO", "CA"];
const vaccines = ["moderna", "jj", "pfizer", "any"];

const hostingURL = functions.config().hosting.url;
const unsubscribeURL = `${hostingURL}/unsubscribe`;

interface Providers {
  id: number;
  key: string;
  url: string;
  name: string;
  status: string;
  provider_id: string;
  location_count: number;
  appointments_last_fetched: Date;
  appointments_last_modified: Date;
}

interface Metadata {
  code: string;
  name: string;
  store_count: number;
  bounding_box: {
    type: string;
    coordinates: [[number, number]];
  };
  provider_brands: Providers[];
  provider_brand_count: number;
  appointments_last_fetched: Date;
  appointments_last_modified: Date;
}

interface StoreData {
  id: number;
  url: string;
  city: string;
  name: string;
  state: string;
  address: string;
  provider: string;
  time_zone: string;
  postal_code: string;
  appointments: [];
  provider_brand: string;
  carries_vaccine: boolean;
  appointment_types: any;
  provider_brand_id: number;
  provider_brand_name: string;
  provider_location_id: number;
  appointments_available: boolean;
  appointment_vaccine_types: any;
  appointments_last_fetched: Date;
  appointments_last_modified: Date;
  appointments_available_all_doses: boolean;
  appointments_available_2nd_dose_only: boolean;
}

interface Stores {
  type: string;
  geometry: {
    type: string;
    coordinates: [number, number];
  };
  properties: StoreData
}

interface StateCollection {
  type: string;
  features: Stores[];
  metadata: Metadata;
}

interface User {
  phone: string;
  state: string;
  coordinates: Coordinates;
  distance: number;
  vaccine: string;
  threshold: number;
}

interface Coordinates {
  longitude: number;
  latitude: number;
}

exports.refreshMinute = functions.pubsub.schedule("every 1 minutes").onRun(async (context): Promise<any> => {
  await refreshData();
  return null;
});

exports.refresh = functions.https.onRequest(async (req, res): Promise<any> => {
  if (req.method != "POST") {
    return res.send("invalid");
  }
  await refreshData();
  return res.send("done");
});

async function refreshData() {
  const ref = db.ref("states");
  const p: Promise<void>[] = [];
  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    const r = axios.get<StateCollection>(`${apiURL}/${state}.json`)
        .then(function(response: AxiosResponse<StateCollection>) {
        // handle success
          console.log(`Done getting ${state}`);
          ref.child(state).child("metadata").set(response.data.metadata);
          const features: { [key: number]: Stores } = {};
          response.data.features.forEach(function(f) {
            features[f.properties.id] = f;
          });
          ref.child(state).child("features").set(features);
        })
        .catch(function(error: AxiosError) {
          console.log(`Error getting ${state}: ${error.code}`);
        });
    p.push(r);
  }
  await Promise.all(p);
  console.log("Done refreshing states");
  return null;
}

exports.checkState = functions.database
    .ref("/states/{stateId}/features/{fid}/properties/appointments")
    .onUpdate(async (snapshot, context): Promise<any> => {
      const state = context.params.stateId;
      const fid = context.params.fid;
      if (snapshot.after.val().length < 1) {
        return;
      }

      const ref = db.ref("states").child(state).child("features").child(fid);
      const providerSnapshot = await ref.once("value");
      const pData: Stores = providerSnapshot.val();
      console.log(`Vaccine found ${state}, property ${fid}, ${JSON.stringify(pData)}`);
      const pCord = {
        longitude: pData.geometry.coordinates[0],
        latitude: pData.geometry.coordinates[1],
      };

      let types = ["any"];
      if (pData.properties.appointment_vaccine_types != null) {
        types = Object.keys(pData.properties.appointment_vaccine_types);
      }

      const userRef = db.ref("users").orderByChild("state").equalTo(state);
      const userSnapshot = await userRef.once("value");

      const p: Promise<void>[] = [];

      userSnapshot.forEach(function(child) {
        const cData: User = child.val();
        console.log(`Found user ${child.key}`);

        if (cData.vaccine != "any") {
          if (!pData.properties.appointment_vaccine_types || !types.includes(cData.vaccine)) {
            console.log(`Wrong vaccine for user ${child.key} ${pData.properties.appointment_vaccine_types} doesn't include ${cData.vaccine}`);
            return;
          }
        }

        const cCord = cData.coordinates;
        const d = getDistance(pCord, cCord);
        const dMiles = Math.ceil(convertDistance(d, "mi"));
        if (dMiles > cData.distance) {
          console.log(`Wrong distance for user ${child.key}, ${dMiles} > ${cData.distance}`);
          return;
        }
        const numb = pData.properties.appointments.length;
        if (cData.threshold != 0 && numb < cData.threshold) {
          console.log(`Wrong threshold for user ${child.key}, ${numb} < ${cData.threshold}`);
          return;
        }
        if (snapshot.before.val().length > cData.threshold) {
          console.log(`Already sent threshold for user ${child.key}, ${cData.threshold} < ${snapshot.before.val().length}`);
          return;
        }

        const provider = pData.properties.provider;
        const address = pData.properties.address;
        const city = pData.properties.city;
        const url = pData.properties.url;
        const lastModified = new Date(pData.properties.appointments_last_modified).toLocaleString();
        const pr = notify(cData.phone, `Found ${numb} appointments for COVID vaccines ${types} at ${provider} ${address}, ${city}. ${dMiles} mile(s) away.  Sign up at ${url}. ${lastModified}`);
        console.log(`Sent vaccine notification to user ${child.key} ${JSON.stringify(pData.properties)}`);

        p.push(pr);
      });

      Promise.all(p);
    });


exports.subscribe = functions.https.onRequest(async (req: functions.Request, res: functions.Response): Promise<any> => {
  const ref = db.ref("users");
  if (!("state" in req.body)) {
    return res.status(status.PRECONDITION_FAILED).send(`Missing state: ${JSON.stringify(req.body)}`);
  }
  if (!states.includes(req.body.state)) {
    return res.status(status.PRECONDITION_FAILED).send(`Invalid state: ${JSON.stringify(req.body.state)} in ${states}`);
  }
  if (!("distance" in req.body)) {
    return res.status(status.PRECONDITION_FAILED).send(`Missing distance: ${JSON.stringify(req.body)}`);
  }
  const distance = parseInt(req.body.distance, 10);
  if (isNaN(distance)) {
    return res.status(status.PRECONDITION_FAILED).send(`Invalid distance: ${JSON.stringify(req.body.distance)}`);
  }
  if (!("vaccine" in req.body)) {
    return res.status(status.PRECONDITION_FAILED).send(`Missing vaccine: ${JSON.stringify(req.body)}`);
  }
  if (!vaccines.includes(req.body.vaccine)) {
    return res.status(status.PRECONDITION_FAILED).send(`Invalid vaccine: ${JSON.stringify(req.body.vaccine)}`);
  }
  if (!("phone" in req.body)) {
    return res.status(status.PRECONDITION_FAILED).send(`Missing phone number: ${JSON.stringify(req.body)}`);
  }
  const [p] = phone(req.body.phone, "USA");
  if (!p) {
    return res.status(status.PRECONDITION_FAILED).send(`Invalid US phone number: ${JSON.stringify(req.body.phone)}`);
  }

  let coordinates: Coordinates;
  if ("coordinates" in req.body) {
    if (req.body.coordinates.length !== 2) {
      return res.status(status.PRECONDITION_FAILED).send(`Invalid coordinates: ${JSON.stringify(req.body.coordinates)}`);
    }
    coordinates = {latitude: req.body.coordinates[0], longitude: req.body.coordinates[1]};
  } else if ("zip" in req.body) {
    try {
      coordinates = await getCoordinates(req.body.zip.toString());
    } catch (err) {
      return res.status(status.INTERNAL_SERVER_ERROR).send(`Couldn't get coordinates for: ${JSON.stringify(req.body.zip)}`);
    }
  } else {
    return res.status(status.PRECONDITION_FAILED).send(`Must include coordinates or zip: ${JSON.stringify(req.body)}`);
  }

  if (!isValidCoordinate(coordinates)) {
    return res.status(status.PRECONDITION_FAILED).send(`Invalid coordinates: ${JSON.stringify(coordinates)}`);
  }

  let threshold = 1;
  if ("threshold" in req.body) {
    threshold = parseInt(req.body.threshold, 10);
  }
  const s: User = {
    phone: p,
    state: req.body.state,
    coordinates: coordinates,
    distance: distance,
    vaccine: req.body.vaccine,
    threshold: threshold,
  };

  const existing = await ref.orderByChild("phone").equalTo(p).limitToFirst(1).once("value");
  console.log(`${p}  exists ${existing.numChildren()}..`);
  if (existing.val() !== null) {
    const e = Object.keys(existing.val())[0];
    await ref.child(e).set(s);
    await notify(p, `You've successfully updated your notifications for the COVID19 vaccine (${req.body.vaccine} brand) in ${req.body.state}. Unsubscribe at any time at ${unsubscribeURL}?uid=${e}`);
    return res.send(`updated subscription for: id ${e} : ${JSON.stringify(s)}`);
  }

  const uRef = ref.push();
  await uRef.set(s);

  await notify(p, `You've successfully subscribed to covid notifications for the COVID19 vaccine (${req.body.vaccine} brand) in ${req.body.state}. Unsubscribe at any time at ${unsubscribeURL}?uid=${uRef.key}`);
  return res.send(`subscribed id ${uRef.key} : ${JSON.stringify(s)}`);
});


exports.unsubscribe = functions.https.onRequest(async (req: functions.Request, res: functions.Response): Promise<any> => {
  const ref = db.ref("users");

  if (!("uid" in req.query)) {
    return res.status(status.PRECONDITION_FAILED).send(`Missing subscription id: ${JSON.stringify(req.query)}`);
  }
  const uid = req.query.uid;
  if (uid === "" || Array.isArray(uid) || String(uid) === "") {
    return res.status(status.PRECONDITION_FAILED).send(`Invalid subscription id: ${JSON.stringify(uid)}`);
  }

  const uRef = ref.child(String(uid));
  const existing = await uRef.once("value");
  if (existing.val() == null) {
    return res.send("no subscription found");
  }
  await uRef.remove();

  await notify(existing.val().phone, "You've successfully unsubscribed");
  return res.send(`unsubscribed id ${req.query.uid} : ${JSON.stringify(existing.val())}`);
});


async function notify(phone: string, message: string): Promise<any> {
  return twilioClient.messages.create({
    to: phone,
    from: twilioNumber,
    body: message,
  });
}

async function getCoordinates(zip: string): Promise<Coordinates> {
  const client = new Client({});
  return await client
      .geocode({
        params: {
          address: zip,
          key: mapsAPI,
        },
        timeout: 1000, // milliseconds
      })
      .then((r) => {
        console.log(r.data.results[0]);
        const latitude = r.data.results[0].geometry.location.lat;
        const longitude = r.data.results[0].geometry.location.lng;
        return {latitude, longitude};
      });
}
