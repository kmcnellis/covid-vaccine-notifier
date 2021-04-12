# SMS notifications for Vaccine Appointments

## About
Uses the api from https://www.vaccinespotter.org to load the avalible appointments every minute. When the appointments_available_all_doses state changes to true, it will notify all subscribers within the specified radius.

Currently only enabled for Colorado and California.

## Subscribe
```
curl --request POST -H "Content-Type:application/json"  -d '{"state": "<CO|CA>, "vaccine":"any", "phone":"<PHONE NUMBER>", "distance":<DISTANCE IN MILES>,"zip":"<YOUR ZIP CODE", "threshold":<Apointements needed per location before notifying>}'   https://covid-spotter.web.app/subscribe
```

## Run yourself

### Setup
```
$ firebase use <project>
$ firebase functions:config:set twilio.phone="<number purchased from twilio"
$ firebase functions:config:set twilio.sid="<twilio sid>" twilio.token="<twilio token>"
$ firebase functions:config:set maps.key="<google maps geocode api key>"
```

### Local
```
$ firebase functions:config:set hosting.url="http://localhost:5001"
$ functions:config:get > .runtimeconfig.json
$ firebase emulators:start
```

### Deploy
```
$ firebase functions:config:set hosting.url="<real hosting url>"
$ firebase deploy
```