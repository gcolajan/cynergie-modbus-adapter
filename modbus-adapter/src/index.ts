import * as schedule from 'node-schedule';
import { Configuration } from './Configuration';
import { createControllers } from './helpers/ConfigHelper';
import { DatasetHelper } from './helpers/DatasetHelper';
import { ExtractHelper } from './helpers/ExtractHelper';
import { CsvHelper } from './helpers/CsvHelper';
import { FakeProvider } from './providers/FakeProvider';
import { ModBusProvider } from './providers/ModBusProvider';

const config = require('../config.json') as Configuration;

//import for metrics server
const express = require('express');
const cluster = require('cluster');
const server = express();
const register = require('../node_modules/prom-client').register;
const Gauge = require('../node_modules/prom-client').Gauge;

//create controllers 
const controllers = createControllers(config.controllers);

//create gauge for each controller and register 
for (const c of controllers) {
	for (const r of c.registers) {
		r.gauge = new Gauge({
			name: c.name + "_" + r.label,
			help: 'Electrecite ETS', 
			labelNames: ['unit', 'parameter']
		});
	}
}


/// show the tha the debug monde started
const args = process.argv.slice(2);
const debugMode = args.length === 1;
if (debugMode) {
	console.warn('Debug mode enabled!');
}
console.log(`Service started (frq: ${config.readFrequency.interval}ms, occ: ${config.readFrequency.requiredOccurences})!`);


// Declare the functions used to retrieve data from each controllers
const ChosenProvider = debugMode ? FakeProvider : ModBusProvider;
const controllerFetching = controllers.map(c => {
	const provider = new ChosenProvider(c.address, c.port, c.slaveId);
	return () => {
		const date = new Date();
		let promise = provider.connect();
		promise = promise.then(() => []);

		c.readings.forEach(r => {
			promise = promise
				.then((v: any[]) => provider.read(r.address, r.nbRegisters)
				.then(raw => { v.push(r.recompose(raw.buffer)); return v; }));
		});

		promise = promise.catch(err => console.error('Error encountered with controller fetching:', err));
		promise = promise.then(values => {
			provider.close();
			return {
				time: date,
				name: c.name,
				data: DatasetHelper.flatten(values),
				controller: c
			}
		});

		return promise;
	}
});


//set the labels and the value for each gauge (register)
const fetchFunction = () => {
	console.log('[' + new Date().toISOString() + '] fetch');
	controllerFetching.forEach((fetch, index) => {
		fetch()
			.then(dataset => {
					dataset.data.forEach(d => {
						const r = d.register;
						r.gauge.set({ unit: r.unit, parameter: r.label }, d.data);
					});
			})
			.catch(reason => console.error(reason));
	});
};

// Run!
if (config.readFrequency.scheduled) {
	schedule.scheduleJob(config.readFrequency.scheduled, fetchFunction);
}
else {
	fetchFunction();
	setInterval(fetchFunction, config.readFrequency.interval);
}

//expose metrics
server.get('/metrics', (req, res) => {
	res.set('Content-Type', register.contentType);
	res.end(register.metrics());
});

console.log('Server listening to 3002, metrics exposed on /metrics endpoint');
server.listen(3002);
