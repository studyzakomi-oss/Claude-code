import { registerRootComponent } from 'expo';

// Defines the background geofence task; must load before the app renders.
import './src/engine';
import App from './App';

registerRootComponent(App);
