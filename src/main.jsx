import { Buffer } from 'buffer'
globalThis.Buffer = Buffer

import { lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import App from './app'
import Home from './pages/home'
import './style.css'

// Lazy-load heavy pages — they pull in ethers, seaport-js, etc.
const Create = lazy(() => import('./pages/create'))
const Offer = lazy(() => import('./pages/offer'))
import Offers from './pages/offers'
import Faq from './pages/faq'

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'create', element: <Create /> },
      { path: 'offer/:chainId/:txHash', element: <Offer /> },
      { path: 'offers', element: <Offers /> },
      { path: 'faq', element: <Faq /> },
    ],
  },
])

createRoot(document.getElementById('root')).render(<RouterProvider router={router} />)
